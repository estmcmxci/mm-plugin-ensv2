#!/usr/bin/env node
// Exercise the plugin's read logic against a public Sepolia RPC with a plain
// viem client — no wallet, no install. The `mm ensv2 *` commands run these
// exact functions against the host-provided client.
//
//   npm run check                       status (the fail-closed checks)
//   npm run check -- whois name.eth
//   npm run check -- resolver name.eth
//   npm run check -- resolve name.eth | 0xaddress
//   npm run check -- provision-plan <name> <owner> [agentURI|none] [years]
//
// Every mode runs against ONE pinned deployment, chosen exactly as the plugin
// chooses it: `--deployment <beta|hackathon>` anywhere on the command line,
// else MM_ENSV2_DEPLOYMENT, else `beta`. The flag is stripped from the
// positional arguments before they are read, so it can go anywhere:
//
//   npm run check -- --deployment hackathon status
//   npm run check -- whois grilledcheese.eth --deployment hackathon
//   MM_ENSV2_DEPLOYMENT=hackathon npm run check -- deploy-plan 0x…
//
// ETH_RPC_URL overrides the endpoint.
import { createPublicClient, http } from "viem";
import { DEPLOYMENTS, DEFAULT_DEPLOYMENT_KEY, DEPLOYMENT_KEYS } from "../dist/lib/deployments.js";
import { detectEnsV2, selfCheck } from "../dist/lib/ensv2.js";
import { resolveQuery, resolverInfo, whois } from "../dist/lib/reads.js";
import { buildDeployPlan, ownedResolverStatus } from "../dist/lib/resolver.js";
import { agentInfo, bindPlan, findAgentIdsForName, setUriPlan } from "../dist/lib/agent.js";
import { buildRecordsMulticall, defaultContext, endpointKey, planRecords, readRecordSet } from "../dist/lib/records.js";
import { ensip25Key } from "../dist/lib/erc7930.js";
import { planSetPrimary, primaryStatus } from "../dist/lib/primary.js";
import { decodeFunctionData, decodeFunctionResult, getAddress, parseAbi } from "viem";
import { namehash } from "viem/ens";
import { adapter8004Abi, permissionedResolverG2Abi, resolverAbi, verifiableFactoryAbi } from "../dist/lib/abis.js";
import {
  ZERO_ADDRESS, ZERO_REFERRER, buildApprove, buildCommit, buildRegister, checkAvailable, computeCommitment,
  makeSecret, quoteRegistration, tokenState, yearsToSeconds,
} from "../dist/lib/registrar.js";
import { viemProvisionChain } from "../dist/lib/chain.js";
import { MemoryJobStore, redactJobFile } from "../dist/lib/jobs.js";
import { PlanRefused, observeJob, planProvision, stepsFor } from "../dist/lib/provision.js";
import { SCHEMA_IDS, validateSchema } from "../dist/lib/schema.js";

const rpc = process.env.ETH_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ transport: http(rpc) });

// --- deployment selection: flag > env > default, same precedence as the plugin.
const rawArgs = process.argv.slice(2);
const argv = [];
let deploymentKey = process.env.MM_ENSV2_DEPLOYMENT?.trim() || DEFAULT_DEPLOYMENT_KEY;
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--deployment") { deploymentKey = rawArgs[++i]; continue; }
  if (a?.startsWith("--deployment=")) { deploymentKey = a.slice("--deployment=".length); continue; }
  argv.push(a);
}
const DEPLOYMENT = DEPLOYMENTS[deploymentKey];
if (!DEPLOYMENT) {
  console.error(`unknown deployment "${deploymentKey}" — one of: ${DEPLOYMENT_KEYS.join(", ")}`);
  process.exit(2);
}
const [cmd = "status", arg] = argv;
console.error(`[deployment ${DEPLOYMENT.key} — ${DEPLOYMENT.deploymentId}, generation ${DEPLOYMENT.generation}, chain ${DEPLOYMENT.chainId}]`);

const show = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const need = (v, what) => {
  if (!v) {
    console.error(`usage: npm run check -- ${cmd} <${what}>`);
    process.exit(2);
  }
  return v;
};
const gate = async () => {
  const d = await detectEnsV2(client, DEPLOYMENT);
  if (!d.isV2) {
    console.error(`ENSv2 NOT ACTIVE on deployment ${DEPLOYMENT.key} (${DEPLOYMENT.deploymentId}, generation ${DEPLOYMENT.generation}) — ${d.reason}`);
    process.exit(1);
  }
  return DEPLOYMENT;
};

try {
  switch (cmd) {
    case "status":
      await selfCheck(rpc, DEPLOYMENT);
      break;
    case "whois":
      show(await whois(client, await gate(), need(arg, "name")));
      break;
    case "resolver":
      show(await resolverInfo(client, await gate(), need(arg, "name")));
      break;
    case "resolve":
      show(await resolveQuery(client, await gate(), DEPLOYMENT.chainId, need(arg, "name|address")));
      break;
    case "predict":
      // Where would <owner>'s resolver be, and does it exist? Read-only.
      show(await ownedResolverStatus(client, await gate(), need(arg, "owner-address")));
      break;
    case "available":
      show(await checkAvailable(client, await gate(), need(arg, "label|name.eth")));
      break;
    case "price": {
      // npm run check -- price <label> [years]
      const years = argv[2];
      show(await quoteRegistration(client, await gate(), need(arg, "label|name.eth"), yearsToSeconds(years)));
      break;
    }
    case "register-plan": {
      // npm run check -- register-plan <label> <owner> [years]
      // Everything `ensv2 register` would do, up to but not including sending. Throwaway secret.
      const d = await gate();
      const owner = need(argv[2], "owner-address");
      const avail = await checkAvailable(client, d, need(arg, "label"));
      const res = await ownedResolverStatus(client, d, owner);
      const duration = yearsToSeconds(argv[3]);
      const quote = avail.available ? await quoteRegistration(client, d, avail.label, duration) : null;
      const funds = await tokenState(client, d, owner);
      const params = { label: avail.label, owner, secret: makeSecret(), subregistry: ZERO_ADDRESS, resolver: res.predicted, durationSeconds: duration, referrer: ZERO_REFERRER };
      const commitment = await computeCommitment(client, d, params);
      const [approve, commit, register] = [buildApprove(d, BigInt(quote?.total ?? 0)), buildCommit(d, commitment), buildRegister(d, params)];
      let commitSim = "not simulated";
      try { await client.call({ account: owner, to: commit.to, data: commit.data }); commitSim = "ok (eth_call from owner succeeds)"; } catch (e) { commitSim = "REVERTED: " + (e.shortMessage ?? e.message); }
      show({
        name: avail.name, available: avail.available,
        resolver: { predicted: res.predicted, deployed: res.deployed, verified: res.verified },
        quote: quote && { total: quote.formatted.total, symbol: quote.paymentToken.symbol, years: quote.durationYears },
        funds: { balance: funds.balance.toString(), allowance: funds.allowance.toString(), sufficient: quote ? funds.balance >= BigInt(quote.total) : null },
        commitment, commitSimulation: commitSim,
        calldata: { approve: { to: approve.to, selector: approve.data.slice(0, 10), bytes: (approve.data.length - 2) / 2 }, commit: { to: commit.to, selector: commit.data.slice(0, 10), bytes: (commit.data.length - 2) / 2 }, register: { to: register.to, selector: register.data.slice(0, 10), bytes: (register.data.length - 2) / 2 } },
      });
      break;
    }
    case "agent-plan": {
      // npm run check -- agent-plan <name> <owner> <agentURI>
      // Preconditions + calldata, then eth_call the REAL adapter.register from the owner: returns the agentId it would mint.
      const d = await gate();
      const owner = need(argv[2], "owner-address");
      const plan = await bindPlan(client, d, need(arg, "name"), owner, need(argv[3], "agentURI"));
      let sim;
      try {
        const { data } = await client.call({ account: owner, to: plan.calldata.to, data: plan.calldata.data });
        sim = { ok: true, wouldMintAgentId: decodeFunctionResult({ abi: adapter8004Abi, functionName: "register", data }).toString() };
      } catch (e) { sim = { ok: false, reverted: e.shortMessage ?? e.message }; }
      show({ name: plan.name, owner, tokenContract: plan.tokenContract, tokenId: "0x" + plan.tokenId.toString(16), standard: plan.standard, agentURI: plan.agentURI,
             calldata: { to: plan.calldata.to, selector: plan.calldata.data.slice(0, 10), bytes: (plan.calldata.data.length - 2) / 2 }, simulation: sim });
      break;
    }
    case "records-get": {
      // npm run check -- records-get <name> [agentId,...]
      const d = await gate();
      show(await readRecordSet(client, d, need(arg, "name"), { agentIds: argv[2] ? argv[2].split(",") : [] }));
      break;
    }
    case "records-plan": {
      // npm run check -- records-plan <name> <owner> <description> <webUrl> <agentId>
      // Diff vs chain, build the multicall, eth_call it from the owner. Nothing sent.
      const d = await gate();
      const [name, owner, description, web, agentId] = [need(arg, "name"), need(argv[2], "owner"), argv[3] ?? "ENSv2 agent wallet on Sepolia", argv[4] ?? "https://estmcmxci.co", argv[5]];
      const endpoints = { web };
      const texts = { description, url: web, [endpointKey("web")]: web, "agent-context": defaultContext(name, description, endpoints, agentId) };
      if (agentId) texts[ensip25Key(d.chainId, d.identityRegistry, agentId)] = "1";
      const plan = await planRecords(client, d, name, owner, { addr: owner, texts });
      let sim = "nothing to write";
      if (plan.calldata) { try { await client.call({ account: owner, to: plan.calldata.to, data: plan.calldata.data }); sim = "ok (eth_call of the multicall from owner succeeds)"; } catch (e) { sim = "REVERTED: " + (e.shortMessage ?? e.message); } }
      show({ name: plan.name, resolver: plan.resolver, calls: plan.calls, changes: Object.fromEntries(Object.entries(plan.changes).map(([k, c]) => [k, { from: c.from, to: c.to.length > 80 ? c.to.slice(0, 77) + "..." : c.to }])), unchanged: plan.unchanged, calldataBytes: plan.calldata ? (plan.calldata.data.length - 2) / 2 : 0, simulation: sim });
      break;
    }
    case "agent-uri-plan": {
      // npm run check -- agent-uri-plan <name> <owner> <uri> [agentId]   — setAgentURI calldata, eth_call'd from owner. Nothing sent.
      const d = await gate();
      const [name, owner, uri] = [need(arg, "name"), need(argv[2], "owner"), need(argv[3], "uri")];
      let id = argv[4] ? BigInt(argv[4]) : null;
      if (id === null) { const s = await findAgentIdsForName(client, d, name, { all: true }); if (!s.agentIds.length) { console.error(`no AgentBound for ${name}`); process.exit(1); } id = s.agentIds[0]; }
      const plan = await setUriPlan(client, d, name, owner, id, uri);
      let sim = "already set — nothing to send";
      if (plan.calldata) { try { await client.call({ account: owner, to: plan.calldata.to, data: plan.calldata.data }); sim = "ok (eth_call of setAgentURI from owner succeeds)"; } catch (e) { sim = "REVERTED: " + (e.shortMessage ?? e.message); } }
      show({ name: plan.name, agentId: plan.agentId, owner, currentURI: plan.currentURI, desiredURI: plan.desiredURI, alreadySet: plan.alreadySet, calldata: plan.calldata ? { ...plan.calldata, value: "0" } : null, simulation: sim });
      break;
    }
    case "agent-info": {
      // npm run check -- agent-info <name> [agentId]
      const d = await gate();
      let id = argv[2] ? BigInt(argv[2]) : null;
      if (id === null) { const s = await findAgentIdsForName(client, d, need(arg, "name"), { all: true }); if (!s.agentIds.length) { console.error(`no AgentBound for ${arg} in ${s.scannedFrom}-${s.scannedTo}`); process.exit(1); } id = s.agentIds[0]; }
      show(await agentInfo(client, d, need(arg, "name"), id));
      break;
    }
    case "primary": {
      // npm run check -- primary <address>   — raw v1 reverse record + UR round-trip, and the registrar derivation
      const d = await gate();
      show(await primaryStatus(client, d, d.chainId, need(arg, "address")));
      break;
    }
    case "primary-plan": {
      // npm run check -- primary-plan <name> <owner>   — the exact setName calldata, eth_call'd from owner. Nothing sent.
      const d = await gate();
      const plan = await planSetPrimary(client, d, d.chainId, need(argv[2], "owner"), need(arg, "name"));
      let sim = "already set — nothing to send";
      if (plan.calldata) { try { await client.call({ account: plan.owner, to: plan.calldata.to, data: plan.calldata.data }); sim = "ok (eth_call of setName from owner succeeds)"; } catch (e) { sim = "REVERTED: " + (e.shortMessage ?? e.message); } }
      show({ ...plan, calldata: plan.calldata ? { ...plan.calldata, value: "0" } : null, simulation: sim });
      break;
    }
    case "provision-plan": {
      // npm run check -- provision-plan <name> <owner> [agentURI|none] [years]
      // Everything `ensv2 provision` would decide before touching the wallet: the intent (validated against the
      // frozen schema) and its digest, the job id, the step list, and what each step observes on chain right now.
      // Uses an in-memory job store, so ~/.mm-plugin-ensv2/jobs is never read or written. Nothing is sent.
      const d = await gate();
      const owner = need(argv[2], "owner-address");
      const uriArg = argv[3];
      const agentUri = uriArg && uriArg !== "none" ? uriArg : null;
      const chain = viemProvisionChain(client, d);
      const label = need(arg, "name").replace(/\.eth$/, "");
      const web = "https://example.invalid";
      const req = {
        input: arg, owner, durationSeconds: yearsToSeconds(argv[4]),
        identity: agentUri ? { agentUri } : null,
        records: { addr: owner, texts: { description: "ENSv2 agent wallet on Sepolia (provision-plan check)", url: web, [endpointKey("web")]: web, "agent-context": defaultContext(label + ".eth", "ENSv2 agent wallet on Sepolia (provision-plan check)", { web }, undefined) } },
        resolverMode: "deploy-owned",
      };
      let plan;
      try { plan = await planProvision({ chain, deployment: d, store: new MemoryJobStore(), log: (l, m) => console.error(`[${l}] ${m}`) }, req, { checkFunding: false }); }
      catch (e) { if (e instanceof PlanRefused) { show({ refused: e.error }); process.exit(1); } throw e; }
      const file = plan.file;
      const intentCheck = validateSchema(SCHEMA_IDS.intent, file.intent);
      const jobCheck = validateSchema(SCHEMA_IDS.job, file.job);
      const observations = await observeJob(chain, d, file);
      const sims = {};
      const res = await ownedResolverStatus(client, d, owner);
      if (!res.deployed) {
        const dp = buildDeployPlan(d, res);
        try { await client.call({ account: owner, to: dp.to, data: dp.data }); sims.resolverDeploy = "ok (eth_call from owner succeeds)"; } catch (e) { sims.resolverDeploy = "REVERTED: " + (e.shortMessage ?? e.message); }
      }
      const commit = buildCommit(d, file.job.facts.commitmentHash);
      try { await client.call({ account: owner, to: commit.to, data: commit.data }); sims.commit = "ok (eth_call from owner succeeds)"; } catch (e) { sims.commit = "REVERTED: " + (e.shortMessage ?? e.message); }
      const funds = await tokenState(client, d, owner);
      show({
        jobId: file.job.jobId, intentHash: file.intent.eip712.intentHash, deploymentId: d.deploymentId,
        alreadyRegistered: plan.alreadyRegistered, quoteTotal: plan.quoteTotal.toString(),
        funds: { balance: funds.balance.toString(), allowance: funds.allowance.toString(), sufficient: funds.balance >= plan.quoteTotal },
        schema: { intent: intentCheck.ok ? "valid" : intentCheck.errors, job: jobCheck.ok ? "valid" : jobCheck.errors },
        steps: stepsFor(file.intent), observations, wouldSubmit: observations.filter((o) => o.wouldSubmit).map((o) => o.step),
        simulations: sims,
        intent: file.intent,
        job: redactJobFile(file).job,
      });
      break;
    }
    case "deploy-plan": {
      // The exact calldata `ensv2 resolver deploy` would hand to the wallet, plus
      // an eth_call of it from the owner. Nothing is sent.
      //
      // The simulation is the PROOF of the CREATE2 salt scheme on a deployment
      // whose factory has never deployed a proxy (there is no ProxyDeployed event
      // to check against on `hackathon`): deployProxy's return value must equal
      // the address `predictOwnedResolver` computed locally.
      const d = await gate();
      const s = await ownedResolverStatus(client, d, need(arg, "owner-address"));
      const plan = buildDeployPlan(d, s);
      let sim = "already deployed — nothing to send";
      if (!s.deployed) {
        try {
          const { data } = await client.call({ account: s.owner, to: plan.to, data: plan.data });
          const returned = decodeFunctionResult({ abi: verifiableFactoryAbi, functionName: "deployProxy", data });
          sim = getAddress(returned) === getAddress(plan.predicted)
            ? `ok — deployProxy returns ${returned}, exactly the predicted address`
            : `MISMATCH — deployProxy returns ${returned}, prediction says ${plan.predicted}`;
        } catch (e) { sim = "REVERTED: " + (e.shortMessage ?? e.message); }
      }
      show({ ...plan, value: "0", alreadyDeployed: s.deployed, initializer: d.generation === "g2" ? "initialize(Grant[],bytes[])" : "initialize(address,uint256,bytes[])", simulation: sim });
      break;
    }

    case "g2-setters": {
      // Prove the g2 record setters this plugin encodes are the ones the deployed
      // PermissionedResolver implementation actually recognises, without sending
      // anything: `decodeSetter(bytes)` is a `pure` function on that contract that
      // decodes a setter call into (argument, EAC resource, required role) and
      // reverts UnsupportedResolverProfile(bytes4) for anything it does not know.
      const d = await gate();
      if (d.generation !== "g2") {
        console.error(`g2-setters only applies to a generation-g2 deployment; ${d.key} is ${d.generation}. Try --deployment hackathon.`);
        process.exit(2);
      }
      const name = need(arg, "name");
      const node = namehash(name);
      const owner = argv[2] ?? "0x00000000000000000000000000000000000000A1";
      const abi = parseAbi(["function decodeSetter(bytes setter) external pure returns (bytes arg, uint256 resource, uint256 roleBitmap)"]);
      const probe = async (label, calldata) => {
        try {
          const r = await client.readContract({ address: d.resolverImplementation, abi, functionName: "decodeSetter", args: [calldata] });
          return { label, selector: calldata.slice(0, 10), recognised: true, arg: r[0], resource: `0x${r[1].toString(16)}`, requiredRole: `0x${r[2].toString(16)}` };
        } catch (e) {
          return { label, selector: calldata.slice(0, 10), recognised: false, revert: (e.shortMessage ?? e.message).split("\n")[0] };
        }
      };
      // What the plugin builds for this deployment, one call per changed key.
      const g2 = buildRecordsMulticall(d, { resolver: d.resolverImplementation, name, node }, {
        addr: { from: null, to: owner },
        description: { from: null, to: "an agent on the ENS Labs ETHOnline deployment" },
      });
      const inner = decodeFunctionData({ abi: permissionedResolverG2Abi, data: g2.calldata.data }).args[0];
      const results = [];
      for (const call of inner) results.push(await probe("plugin-built g2 setter", call));
      // And the g1 shapes, which must NOT be recognised here.
      const g1 = buildRecordsMulticall({ ...d, generation: "g1" }, { resolver: d.resolverImplementation, name, node }, {
        addr: { from: null, to: owner },
        description: { from: null, to: "x" },
      });
      for (const call of decodeFunctionData({ abi: resolverAbi, data: g1.calldata.data }).args[0]) results.push(await probe("g1 setter (must be refused)", call));
      show({ name, resolverImplementation: d.resolverImplementation, multicallSelector: g2.calldata.data.slice(0, 10), calls: g2.calls, results });
      break;
    }
    default:
      console.error(`unknown check "${cmd}" — one of: status, whois, resolver, resolve, predict, available, price, register-plan, agent-plan, agent-info, agent-uri-plan, records-get, records-plan, primary, primary-plan, deploy-plan, g2-setters, provision-plan`);
      process.exit(2);
  }
} catch (error) {
  const code = error?.code ? `[${error.code}] ` : "";
  console.error(`${code}${error?.message ?? error}`);
  if (error?.hint) console.error(`hint: ${error.hint}`);
  process.exit(1);
}
