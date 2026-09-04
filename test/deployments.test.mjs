// Multi-deployment support: the two pinned tables, the generation-aware gate
// (including its refusal to cross-accept), the g2 calldata encoders, and the
// deployment-selection precedence.
//
// Every expectation about the g2 shapes below was first confirmed against the
// DEPLOYED hackathon contracts on 2026-09-04 (selector presence in
// PermissionedResolverImpl's bytecode, `decodeSetter` on that same contract,
// and an eth_call of `deployProxy`). These tests pin the encoders so a
// refactor cannot silently drift off them without a chain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector, zeroAddress } from "viem";
import { namehash } from "viem/ens";
import {
  permissionedResolverAbi,
  permissionedResolverG2Abi,
  permissionedResolverG2InitAbi,
  resolverAbi,
  universalHelperAbi,
} from "../dist/lib/abis.js";
import {
  DEFAULT_DEPLOYMENT_KEY,
  DEPLOYMENTS,
  DEPLOYMENT_KEYS,
  SEPOLIA,
  SEPOLIA_HACKATHON,
  deploymentByDeploymentId,
  deploymentByKey,
  deploymentFor,
  deploymentForChain,
  deploymentsOnChain,
  isDeploymentKey,
} from "../dist/lib/deployments.js";
import {
  UNIVERSAL_RESOLVER_V2_G2_INTERFACE_ID,
  UNIVERSAL_RESOLVER_V2_INTERFACE_ID,
  detectEnsV2,
} from "../dist/lib/ensv2.js";
import { deploymentSelection, parseChainId, parseDeploymentKey, requireDeployment } from "../dist/lib/gate.js";
import { MemoryJobStore } from "../dist/lib/jobs.js";
import { buildRecordsMulticall, COIN_TYPE_ETH } from "../dist/lib/records.js";
import { ALL_ROLES, G2_RESOLVER_ROLE, G2_RESOLVER_ROLES, buildDeployPlan, buildResolverInitData, defaultResolverRoles } from "../dist/lib/resolver.js";
import { assertJobDeployment, jobsFor, planProvision, ProvisionHalt } from "../dist/lib/provision.js";
import { MockChain } from "./mock-chain.mjs";

const OWNER = "0x00000000000000000000000000000000000000A1";
const lower = (s) => String(s).toLowerCase();

// ---------------------------------------------------------------------------
// the table

test("two deployments are pinned, both Sepolia, beta is the default and unchanged", () => {
  assert.deepEqual([...DEPLOYMENT_KEYS], ["beta", "hackathon"]);
  assert.equal(DEFAULT_DEPLOYMENT_KEY, "beta");
  assert.equal(deploymentForChain(11155111), SEPOLIA);
  assert.equal(deploymentFor(11155111), SEPOLIA);
  assert.equal(deploymentFor(11155111, "hackathon"), SEPOLIA_HACKATHON);
  assert.equal(deploymentFor(1, "hackathon"), undefined);
  assert.equal(deploymentsOnChain(11155111).length, 2);
  assert.equal(deploymentsOnChain(1).length, 0);

  // The beta table is byte-for-byte what v0.7.2 shipped.
  assert.equal(SEPOLIA.deploymentId, "ensv2-sepolia-2026-07-30");
  assert.equal(SEPOLIA.generation, "g1");
  assert.equal(SEPOLIA.universalResolver, "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe");
  assert.equal(SEPOLIA.registry, "0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2");
  assert.equal(SEPOLIA.reverseRegistrar, "0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6");
  assert.equal(SEPOLIA.universalHelper, undefined, "g1 has no helper: the UR answers navigation itself");

  assert.equal(SEPOLIA_HACKATHON.deploymentId, "ensv2-sepolia-hackathon-2026-09");
  assert.equal(SEPOLIA_HACKATHON.generation, "g2");
  assert.ok(SEPOLIA_HACKATHON.universalHelper, "g2 must declare a helper");
});

test("the two tables share nothing that must differ, and share exactly what must not", () => {
  const perDeployment = [
    "universalResolver",
    "rootRegistry",
    "registry",
    "registrar",
    "rentPriceOracle",
    "paymentToken",
    "resolverFactory",
    "resolverImplementation",
    "resolverProxyLogic",
    "subregistryImplementation",
    "reverseRegistrar",
  ];
  for (const k of perDeployment) {
    assert.notEqual(lower(SEPOLIA[k]), lower(SEPOLIA_HACKATHON[k]), `${k} must differ between deployments`);
  }
  // ERC-8004 is deployment-independent: same adapter, same canonical registry.
  assert.equal(lower(SEPOLIA.adapter8004), lower(SEPOLIA_HACKATHON.adapter8004));
  assert.equal(lower(SEPOLIA.identityRegistry), lower(SEPOLIA_HACKATHON.identityRegistry));
  // Distinct ids so jobs, receipts and verification results never collide.
  assert.notEqual(SEPOLIA.deploymentId, SEPOLIA_HACKATHON.deploymentId);
  assert.equal(deploymentByDeploymentId(SEPOLIA_HACKATHON.deploymentId), SEPOLIA_HACKATHON);
  assert.equal(deploymentByDeploymentId("ensv2-sepolia-nope"), undefined);
});

test("every pinned address is EIP-55 checksummed", async () => {
  const { getAddress } = await import("viem");
  for (const key of DEPLOYMENT_KEYS) {
    for (const [field, value] of Object.entries(DEPLOYMENTS[key])) {
      if (typeof value !== "string" || !value.startsWith("0x") || value.length !== 42) continue;
      // rentPriceOracle on the beta table is recorded lowercase as shipped in 0.7.2; everything new must be checksummed.
      if (key === "beta") continue;
      assert.equal(value, getAddress(value), `${key}.${field} is not checksummed`);
    }
  }
});

// ---------------------------------------------------------------------------
// deployment selection: flag > env > default

test("selection precedence: --deployment beats the env var beats the default", () => {
  assert.equal(parseDeploymentKey(undefined, {}), "beta");
  assert.equal(parseDeploymentKey("", {}), "beta");
  assert.equal(parseDeploymentKey(undefined, { MM_ENSV2_DEPLOYMENT: "hackathon" }), "hackathon");
  assert.equal(parseDeploymentKey("beta", { MM_ENSV2_DEPLOYMENT: "hackathon" }), "beta", "the flag wins over the env var");
  assert.equal(parseDeploymentKey("hackathon", { MM_ENSV2_DEPLOYMENT: "beta" }), "hackathon");
  assert.equal(parseDeploymentKey("  hackathon  ", {}), "hackathon", "surrounding whitespace is trimmed");
  assert.equal(parseDeploymentKey(undefined, { MM_ENSV2_DEPLOYMENT: "  beta " }), "beta");

  assert.deepEqual(deploymentSelection(undefined, {}), { key: "beta", explicit: false, source: "default" });
  assert.deepEqual(deploymentSelection(undefined, { MM_ENSV2_DEPLOYMENT: "beta" }), { key: "beta", explicit: true, source: "env" });
  assert.deepEqual(deploymentSelection("beta", {}), { key: "beta", explicit: true, source: "flag" });
});

test("an unknown deployment is refused, never silently defaulted", () => {
  for (const [raw, env, where] of [
    ["hackaton", {}, "--deployment"],
    ["mainnet", {}, "--deployment"],
    [undefined, { MM_ENSV2_DEPLOYMENT: "Hackathon" }, "MM_ENSV2_DEPLOYMENT"],
  ]) {
    assert.throws(
      () => parseDeploymentKey(raw, env),
      (e) => e.code === "ENSV2_UNKNOWN_DEPLOYMENT" && e.message.includes(where),
      `${raw ?? env.MM_ENSV2_DEPLOYMENT} should be refused`,
    );
  }
  assert.ok(isDeploymentKey("beta") && isDeploymentKey("hackathon"));
  assert.ok(!isDeploymentKey("toString"), "prototype keys are not deployments");
  assert.equal(deploymentByKey("nope"), undefined);
});

test("requireDeployment: --chain still refuses anything but Sepolia, for both deployments", () => {
  assert.equal(requireDeployment(11155111), SEPOLIA);
  assert.equal(requireDeployment(11155111, "hackathon"), SEPOLIA_HACKATHON);
  assert.equal(parseChainId(undefined), 11155111);
  for (const key of DEPLOYMENT_KEYS) {
    for (const chain of [1, 8453, 11155420]) {
      assert.throws(() => requireDeployment(chain, key), (e) => e.code === "ENSV2_UNSUPPORTED_CHAIN");
    }
  }
});

// ---------------------------------------------------------------------------
// the generation-aware gate, against mocked reads

const ETH_DNS = "0x0365746800";

/**
 * A ReadClient that answers from a table of {address, functionName} -> value.
 * Anything not in the table reverts, exactly as an absent function would.
 */
function mockClient(answers) {
  return {
    async readContract({ address, functionName, args }) {
      const key = `${lower(address)}.${functionName}${functionName === "supportsInterface" ? `(${args[0]})` : ""}`;
      if (!(key in answers)) throw new Error(`execution reverted: no ${key}`);
      const v = answers[key];
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

/** A chain that answers as the real beta (g1) deployment does. */
const g1Answers = (d = SEPOLIA) => ({
  [`${lower(d.universalResolver)}.supportsInterface(${UNIVERSAL_RESOLVER_V2_INTERFACE_ID})`]: true,
  [`${lower(d.universalResolver)}.supportsInterface(${UNIVERSAL_RESOLVER_V2_G2_INTERFACE_ID})`]: false,
  [`${lower(d.universalResolver)}.findCanonicalRegistry`]: d.registry,
  [`${lower(d.rootRegistry)}.getSubregistry`]: d.registry,
  [`${lower(d.registry)}.getParent`]: [d.rootRegistry, "eth"],
  [`${lower(d.resolverFactory)}.proxyLogic`]: d.resolverProxyLogic,
});

/** A chain that answers as the real hackathon (g2) deployment does. */
const g2Answers = (d = SEPOLIA_HACKATHON) => ({
  [`${lower(d.universalResolver)}.supportsInterface(${UNIVERSAL_RESOLVER_V2_G2_INTERFACE_ID})`]: true,
  [`${lower(d.universalResolver)}.supportsInterface(${UNIVERSAL_RESOLVER_V2_INTERFACE_ID})`]: false,
  [`${lower(d.universalResolver)}.findResolver`]: { resolver: zeroAddress, node: `0x${"0".repeat(64)}`, offset: 4n },
  [`${lower(d.universalHelper)}.findCanonicalRegistry`]: d.registry,
  [`${lower(d.rootRegistry)}.getSubregistry`]: d.registry,
  [`${lower(d.registry)}.getParent`]: [d.rootRegistry, "eth"],
  [`${lower(d.resolverFactory)}.proxyLogic`]: d.resolverProxyLogic,
});

test("g1 gate: the original five checks, unchanged", async () => {
  const r = await detectEnsV2(mockClient(g1Answers()), SEPOLIA);
  assert.equal(r.isV2, true);
  assert.equal(r.checks.length, 5, "the beta gate must still be exactly five checks");
  assert.deepEqual(
    r.checks.map((c) => c.name),
    [
      "universalResolver.supportsInterface(IUniversalResolverV2)",
      "universalResolver.findCanonicalRegistry(eth) == configured registry",
      "rootRegistry.getSubregistry(eth) == ethRegistry",
      "ethRegistry.getParent() == (rootRegistry, eth)",
      "resolverFactory.proxyLogic() == configured resolverProxyLogic",
    ],
  );
  assert.equal(r.ethRegistry, SEPOLIA.registry);
  assert.equal(r.proxyLogic, SEPOLIA.resolverProxyLogic);
});

test("g2 gate: seven checks, navigation read from the UniversalHelper", async () => {
  const r = await detectEnsV2(mockClient(g2Answers()), SEPOLIA_HACKATHON);
  assert.equal(r.isV2, true);
  assert.equal(r.checks.length, 7);
  assert.ok(r.checks.every((c) => c.ok));
  assert.ok(r.checks.some((c) => c.name.includes("universalHelper.findCanonicalRegistry")));
  assert.ok(r.checks.some((c) => c.name.includes("findResolver(eth) is callable")));
  assert.equal(r.ethRegistry, SEPOLIA_HACKATHON.registry);
});

test("g2 gate: a UniversalResolver that reverts on findResolver is refused", async () => {
  const answers = g2Answers();
  delete answers[`${lower(SEPOLIA_HACKATHON.universalResolver)}.findResolver`];
  const r = await detectEnsV2(mockClient(answers), SEPOLIA_HACKATHON);
  assert.equal(r.isV2, false);
  assert.match(r.reason, /resolver location/);
  assert.equal(r.checks.find((c) => c.name.includes("findResolver")).ok, false);
});

test("g2 gate: a table with no universalHelper is refused before any RPC", async () => {
  let calls = 0;
  const client = {
    async readContract() {
      calls += 1;
      return true;
    },
  };
  const r = await detectEnsV2(client, { ...SEPOLIA_HACKATHON, universalHelper: undefined });
  assert.equal(r.isV2, false);
  assert.equal(calls, 0);
  assert.match(r.reason, /universalHelper/);
});

test("CROSS-GENERATION: a g1 table refuses g2 contracts, and a g2 table refuses g1 contracts", async () => {
  // A g1-shaped table pointed at the hackathon's Universal Resolver. On chain
  // that UR answers supportsInterface(0xf99a5e06) == false (verified live
  // 2026-09-04), so check 1 rejects it before anything else is read.
  const g1TableOnG2Contracts = { ...SEPOLIA, generation: "g1", universalResolver: SEPOLIA_HACKATHON.universalResolver };
  const onG2 = await detectEnsV2(mockClient(g2Answers()), g1TableOnG2Contracts);
  assert.equal(onG2.isV2, false);
  assert.match(onG2.reason, /does not support IUniversalResolverV2/);
  assert.equal(onG2.checks.length, 1, "it must refuse on the very first check");

  // And the mirror: a g2-shaped table pointed at the beta's UR. There
  // supportsInterface(0x1a6cc9f0) is false, so check 1 rejects it.
  const g2TableOnG1Contracts = { ...SEPOLIA_HACKATHON, generation: "g2", universalResolver: SEPOLIA.universalResolver };
  const onG1 = await detectEnsV2(mockClient(g1Answers()), g2TableOnG1Contracts);
  assert.equal(onG1.isV2, false);
  assert.match(onG1.reason, /g2 IUniversalResolverV2/);
  assert.equal(onG1.checks.length, 1);
});

test("CROSS-GENERATION: a UR answering BOTH interface ids is refused as g2, not accepted", async () => {
  const ambiguous = { ...g2Answers() };
  ambiguous[`${lower(SEPOLIA_HACKATHON.universalResolver)}.supportsInterface(${UNIVERSAL_RESOLVER_V2_INTERFACE_ID})`] = true;
  const r = await detectEnsV2(mockClient(ambiguous), SEPOLIA_HACKATHON);
  assert.equal(r.isV2, false);
  assert.match(r.reason, /both generations/);
  assert.equal(r.checks.length, 2);
});

test("g2 gate: a registry the helper disagrees with is refused", async () => {
  const answers = g2Answers();
  answers[`${lower(SEPOLIA_HACKATHON.universalHelper)}.findCanonicalRegistry`] = SEPOLIA.registry; // the OTHER deployment's registry
  const r = await detectEnsV2(mockClient(answers), SEPOLIA_HACKATHON);
  assert.equal(r.isV2, false);
  assert.match(r.reason, /does not match the UniversalHelper/);
});

test("the helper ABI carries only navigation; the UR keeps resolution", () => {
  const helperFns = universalHelperAbi.filter((x) => x.type === "function").map((x) => x.name).sort();
  assert.deepEqual(helperFns, ["findCanonicalRegistry", "findExactRegistry", "findParentRegistry"]);
  assert.ok(!helperFns.includes("findResolver"));
  assert.ok(!helperFns.includes("resolve"));
});

// ---------------------------------------------------------------------------
// g2 calldata encoders

test("g2 role bitmap comes from the source constants and is a strict subset of ALL_ROLES", () => {
  // The 10 roles PermissionedResolverLib names, plus their admin counterparts.
  const regular = Object.values(G2_RESOLVER_ROLE).reduce((a, b) => a | b, 0n);
  assert.equal(G2_RESOLVER_ROLES, regular | (regular << 128n));
  assert.equal(G2_RESOLVER_ROLE.SET_ADDRESS, 1n);
  assert.equal(G2_RESOLVER_ROLE.SET_TEXT, 1n << 4n);
  assert.equal(G2_RESOLVER_ROLE.UPGRADE, 1n << 124n);
  assert.equal(
    `0x${G2_RESOLVER_ROLES.toString(16)}`,
    "0x1100000000000000000000001111111111000000000000000000000011111111",
  );
  // Strictly fewer bits than g1's blanket literal, and none outside the EAC mask.
  assert.notEqual(G2_RESOLVER_ROLES, ALL_ROLES);
  assert.equal(G2_RESOLVER_ROLES & ~ALL_ROLES, 0n, "no bit outside a nybble's low bit");
  assert.ok((G2_RESOLVER_ROLES & ALL_ROLES) === G2_RESOLVER_ROLES);
  assert.equal(defaultResolverRoles(SEPOLIA), ALL_ROLES);
  assert.equal(defaultResolverRoles(SEPOLIA_HACKATHON), G2_RESOLVER_ROLES);
});

test("g2 resolver initializer is initialize(Grant[],bytes[]) with the wallet as the sole admin", () => {
  const data = buildResolverInitData(SEPOLIA_HACKATHON, OWNER, G2_RESOLVER_ROLES, []);
  assert.equal(data.slice(0, 10), toFunctionSelector("initialize((address,uint256)[],bytes[])"));
  assert.equal(data.slice(0, 10), "0x33cc44a0", "the selector confirmed present in PermissionedResolverImpl's bytecode");
  const { args } = decodeFunctionData({ abi: permissionedResolverG2InitAbi, data });
  assert.equal(args[0].length, 1);
  assert.equal(lower(args[0][0].account), lower(OWNER));
  assert.equal(args[0][0].roleBitmap, G2_RESOLVER_ROLES);
  assert.deepEqual(args[1], []);

  // g1 keeps its three-argument form, and the two selectors differ.
  const g1 = buildResolverInitData(SEPOLIA, OWNER, ALL_ROLES, []);
  assert.equal(g1.slice(0, 10), "0x7058b559");
  const g1Args = decodeFunctionData({ abi: permissionedResolverAbi, data: g1 }).args;
  assert.deepEqual([lower(g1Args[0]), g1Args[1], g1Args[2]], [lower(OWNER), ALL_ROLES, []]);
});

test("buildDeployPlan targets each deployment's own factory and implementation", () => {
  const status = (d) => ({ owner: OWNER, deployer: OWNER, factory: d.resolverFactory, implementation: d.resolverImplementation, proxyLogic: d.resolverProxyLogic, proxyLogicMatchesConfig: true, predicted: OWNER, salt: `0x${"11".repeat(32)}`, outerSalt: `0x${"22".repeat(32)}`, deployed: false, verified: null });
  const g2 = buildDeployPlan(SEPOLIA_HACKATHON, status(SEPOLIA_HACKATHON));
  assert.equal(g2.to, SEPOLIA_HACKATHON.resolverFactory);
  assert.equal(g2.initData.slice(0, 10), "0x33cc44a0");
  assert.equal(g2.roleBitmap, `0x${G2_RESOLVER_ROLES.toString(16)}`);
  assert.ok(g2.data.toLowerCase().includes(SEPOLIA_HACKATHON.resolverImplementation.slice(2).toLowerCase()));

  const g1 = buildDeployPlan(SEPOLIA, status(SEPOLIA));
  assert.equal(g1.to, SEPOLIA.resolverFactory);
  assert.equal(g1.initData.slice(0, 10), "0x7058b559");
  assert.equal(g1.roleBitmap, `0x${ALL_ROLES.toString(16)}`);
});

test("g2 record setters key on the DNS-encoded name; g1 keeps the namehash", () => {
  const name = "grilledcheese.eth";
  const node = namehash(name);
  const dns = "0x0d6772696c6c65646368656573650365746800"; // 13 "grilledcheese", 3 "eth", 0
  const changes = { addr: { from: null, to: OWNER }, description: { from: null, to: "an agent" } };

  const g2 = buildRecordsMulticall(SEPOLIA_HACKATHON, { resolver: SEPOLIA_HACKATHON.resolverImplementation, name, node }, changes);
  assert.equal(g2.calls, 2);
  assert.equal(g2.calldata.to, SEPOLIA_HACKATHON.resolverImplementation);
  assert.equal(g2.calldata.value, 0n);
  assert.equal(g2.calldata.data.slice(0, 10), "0xac9650d8", "multicall(bytes[]) is the same on both generations");
  const inner = decodeFunctionData({ abi: permissionedResolverG2Abi, data: g2.calldata.data }).args[0];

  assert.equal(inner[0].slice(0, 10), "0xb4436dde", "setAddress(bytes,uint256,bytes)");
  const addrCall = decodeFunctionData({ abi: permissionedResolverG2Abi, data: inner[0] });
  assert.equal(addrCall.functionName, "setAddress");
  assert.equal(addrCall.args[0], dns, "keyed on the DNS-encoded name, not the namehash");
  assert.equal(addrCall.args[1], COIN_TYPE_ETH);
  assert.equal(lower(addrCall.args[2]), lower(OWNER), "the 20-byte address, ENSIP-9 style");

  assert.equal(inner[1].slice(0, 10), "0xc7279f88", "setText(bytes,string,string)");
  const textCall = decodeFunctionData({ abi: permissionedResolverG2Abi, data: inner[1] });
  assert.deepEqual([textCall.args[0], textCall.args[1], textCall.args[2]], [dns, "description", "an agent"]);

  // Neither g1 selector appears anywhere in the g2 calldata.
  for (const gone of ["d5fa2b00", "10f13a8c"]) {
    assert.ok(!g2.calldata.data.toLowerCase().includes(gone), `g1 selector ${gone} must not appear in a g2 multicall`);
  }

  // g1 is untouched: namehash-keyed setAddr/setText.
  const g1 = buildRecordsMulticall(SEPOLIA, { resolver: SEPOLIA.resolverImplementation, name, node }, changes);
  const g1Inner = decodeFunctionData({ abi: resolverAbi, data: g1.calldata.data }).args[0];
  assert.equal(g1Inner[0].slice(0, 10), "0xd5fa2b00");
  assert.equal(decodeFunctionData({ abi: resolverAbi, data: g1Inner[0] }).args[0], node);
  assert.equal(g1Inner[1].slice(0, 10), "0x10f13a8c");
  assert.deepEqual(
    [...decodeFunctionData({ abi: resolverAbi, data: g1Inner[1] }).args],
    [node, "description", "an agent"],
  );

  // The two generations produce different calldata for identical inputs.
  assert.notEqual(g1.calldata.data, g2.calldata.data);
});

test("nothing to change is still nothing to send, on both generations", () => {
  for (const d of [SEPOLIA, SEPOLIA_HACKATHON]) {
    const r = buildRecordsMulticall(d, { resolver: d.resolverImplementation, name: "a.eth", node: namehash("a.eth") }, {});
    assert.equal(r.calldata, null);
    assert.equal(r.calls, 0);
  }
});

test("a g2 setter encodes to exactly what the deployed implementation recognises", () => {
  // Reference vectors, byte-for-byte as `decodeSetter` on 0xa9d3814A… parsed
  // them on 2026-09-04: setText -> arg "description", role 0x10 (ROLE_SET_TEXT);
  // setAddress -> arg abi.encodePacked(60), role 0x1 (ROLE_SET_ADDRESS).
  const dns = "0x0d6772696c6c65646368656573650365746800";
  assert.equal(
    encodeFunctionData({ abi: permissionedResolverG2Abi, functionName: "setText", args: [dns, "description", "hello"] }).slice(0, 10),
    "0xc7279f88",
  );
  assert.equal(
    encodeFunctionData({ abi: permissionedResolverG2Abi, functionName: "setAddress", args: [dns, 60n, OWNER] }).slice(0, 10),
    "0xb4436dde",
  );
});

// ---------------------------------------------------------------------------
// the job engine

test("jobs are scoped to their deployment: two deployments, two jobs, same name", async () => {
  const store = new MemoryJobStore();
  const req = { input: "scoped", owner: OWNER, durationSeconds: 31536000n, identity: null, records: { addr: OWNER, texts: {} }, resolverMode: "deploy-owned" };

  const mk = async (deployment) => {
    const chain = new MockChain();
    chain.fund(OWNER, 100_000_000n);
    const plan = await planProvision({ chain, deployment, store }, req);
    assert.equal(plan.kind, "new", `${deployment.key} should get its own new job`);
    await store.create(plan.file);
    return plan.file;
  };
  const betaJob = await mk(SEPOLIA);
  const hackJob = await mk(SEPOLIA_HACKATHON);

  assert.notEqual(betaJob.job.jobId, hackJob.job.jobId, "the deploymentId is the EIP-712 salt, so the ids differ");
  assert.equal(betaJob.job.deploymentId, SEPOLIA.deploymentId);
  assert.equal(hackJob.job.deploymentId, SEPOLIA_HACKATHON.deploymentId);

  // Scoped lookups see only their own; an unscoped one sees both.
  const all = await jobsFor(store, 11155111, "scoped.eth", OWNER);
  assert.equal(all.length, 2);
  const beta = await jobsFor(store, 11155111, "scoped.eth", OWNER, { deploymentId: SEPOLIA.deploymentId });
  assert.deepEqual(beta.map((f) => f.job.jobId), [betaJob.job.jobId]);
  const hack = await jobsFor(store, 11155111, "scoped.eth", OWNER, { deploymentId: SEPOLIA_HACKATHON.deploymentId });
  assert.deepEqual(hack.map((f) => f.job.jobId), [hackJob.job.jobId]);

  // And planning again under each deployment resumes its own job, never the other's.
  const again = await planProvision({ chain: Object.assign(new MockChain(), {}), deployment: SEPOLIA_HACKATHON, store }, req);
  assert.equal(again.kind, "existing");
  assert.equal(again.file.job.jobId, hackJob.job.jobId);
});

test("a job refuses to run under another deployment (E_UNSUPPORTED_DEPLOYMENT)", async () => {
  const store = new MemoryJobStore();
  const chain = new MockChain();
  chain.fund(OWNER, 100_000_000n);
  const plan = await planProvision({ chain, deployment: SEPOLIA, store }, { input: "wrongdep", owner: OWNER, durationSeconds: 31536000n, identity: null, records: { addr: OWNER, texts: {} }, resolverMode: "deploy-owned" });
  await store.create(plan.file);

  // Same chain, same name, same owner — only the deployment differs.
  assert.throws(
    () => assertJobDeployment(SEPOLIA_HACKATHON, plan.file),
    (e) => {
      assert.ok(e instanceof ProvisionHalt);
      assert.equal(e.error.code, "E_UNSUPPORTED_DEPLOYMENT");
      assert.equal(e.error.category, "deployment");
      assert.equal(e.error.retryability, "requires_user_action");
      assert.match(e.error.message, /ensv2-sepolia-2026-07-30/);
      assert.match(e.error.message, /ensv2-sepolia-hackathon-2026-09/);
      return true;
    },
  );
  // Its own deployment is fine.
  assert.doesNotThrow(() => assertJobDeployment(SEPOLIA, plan.file));
});
