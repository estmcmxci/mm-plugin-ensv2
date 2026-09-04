// An in-memory ENSv2 Sepolia for the interruption matrix. It implements the
// engine's ProvisionChain read surface over a small state machine and plays
// the wallet: `apply(from, calldata)` decodes the exact calldata the real
// executor would receive (using the plugin's own ABIs) and mutates state the
// way the deployed contracts would, so every observation the engine makes on
// resume is answered by state the calldata actually produced.
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, isAddressEqual, keccak256, toHex, zeroAddress } from "viem";
import { labelhash, namehash } from "viem/ens";
import { adapter8004Abi, erc20Abi, ethRegistrarAbi, permissionedResolverAbi, resolverAbi, verifiableFactoryAbi } from "../dist/lib/abis.js";
import { AGENT_BOUND } from "../dist/lib/agent.js";
import { SEPOLIA } from "../dist/lib/deployments.js";
import { ensip25Key } from "../dist/lib/erc7930.js";

const hex = (n) => `0x${n.toString(16)}`;
const low32 = 0xffff_ffffn;

export class MockChain {
  constructor() {
    this.d = SEPOLIA;
    this.time = 1_760_000_000;
    this.block = 12_000_000n;
    this.v2Active = true;
    this.adapterImpl = "0x00000000000000000000000000000000000000Ad";
    this.resolvers = new Map(); // predicted (lowercase) -> { owner, verified }
    this.commitments = new Map(); // hash -> chain time
    this.names = new Map(); // label -> { owner, expiry, version, epoch, resolver }
    this.balances = new Map();
    this.allowances = new Map();
    this.agents = []; // { agentId, standard, tokenContract, tokenId, registeredBy, uri }
    this.nextAgentId = 10059n;
    this.records = new Map(); // node -> { addr, texts }
    this.receipts = new Map();
    this.minAge = 60;
    this.maxAge = 86400;
    this.minDuration = 28 * 86400;
    this.price = 8_000_021n;
    this.txCount = 0;
    this.lookupFailures = new Set();
    /** Every applied transaction: { to, fn, from }. The matrix counts these. */
    this.applied = [];
  }

  // ---- helpers ------------------------------------------------------------

  predicted(owner) {
    return getAddress(`0x${keccak256(toHex(`resolver:${owner.toLowerCase()}`)).slice(26)}`);
  }
  entry(label) {
    const n = this.names.get(label);
    return n && n.expiry > this.time ? n : null;
  }
  tokenIdOf(label, n) {
    return (BigInt(labelhash(label)) & ~low32) | BigInt(n?.version ?? 0);
  }
  resourceOf(label, n) {
    return (BigInt(labelhash(label)) & ~low32) | BigInt(n?.epoch ?? 0);
  }
  makeCommitment(p) {
    return keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }],
        [p.label, p.owner, p.secret, p.subregistry, p.resolver, BigInt(p.durationSeconds), p.referrer],
      ),
    );
  }
  fund(owner, amount) {
    this.balances.set(owner.toLowerCase(), amount);
  }
  /** Simulate a role grant: the token id regenerates, the epoch does not. */
  grantRole(label) {
    const n = this.names.get(label);
    n.version += 1;
  }

  // ---- ProvisionChain ------------------------------------------------------

  async detect() {
    const d = this.d;
    if (!this.v2Active) return { isV2: false, chainId: d.chainId, universalResolver: d.universalResolver, reason: "mock endpoint is serving ENSv1", checks: [{ name: "supportsInterface", ok: false, expected: "true", actual: "false" }] };
    return { isV2: true, chainId: d.chainId, universalResolver: d.universalResolver, ethRegistry: d.registry, rootRegistry: d.rootRegistry, proxyLogic: d.resolverProxyLogic, checks: Array.from({ length: 5 }, (_, i) => ({ name: `check-${i + 1}`, ok: true })) };
  }
  async chainTime() {
    return this.time;
  }
  async blockNumber() {
    return this.block;
  }
  async resolverStatus(owner) {
    const predicted = this.predicted(owner);
    const r = this.resolvers.get(predicted.toLowerCase());
    return { owner, deployer: owner, factory: this.d.resolverFactory, implementation: this.d.resolverImplementation, proxyLogic: this.d.resolverProxyLogic, proxyLogicMatchesConfig: true, predicted, salt: `0x${"0".repeat(64)}`, outerSalt: `0x${"0".repeat(64)}`, deployed: !!r, verified: r ? r.verified : null };
  }
  async available(label) {
    return { label, name: `${label}.eth`, available: !this.entry(label), minRegisterDuration: this.minDuration, minCommitmentAge: this.minAge, maxCommitmentAge: this.maxAge };
  }
  async quote(label, duration) {
    if (this.entry(label)) throw new Error(`NameNotAvailable(${label})`);
    const total = this.price;
    return { label, name: `${label}.eth`, durationSeconds: Number(duration), durationYears: Number(duration) / 31536000, paymentToken: { address: this.d.paymentToken, symbol: "USDC", decimals: 6 }, base: total.toString(), premium: "0", total: total.toString(), formatted: { base: (Number(total) / 1e6).toFixed(6), premium: "0", total: (Number(total) / 1e6).toFixed(6) }, minRegisterDuration: this.minDuration };
  }
  async tokenState(owner) {
    return { balance: this.balances.get(owner.toLowerCase()) ?? 0n, allowance: this.allowances.get(owner.toLowerCase()) ?? 0n };
  }
  async computeCommitment(p) {
    return this.makeCommitment(p);
  }
  async commitmentTime(c) {
    return this.commitments.get(c) ?? 0;
  }
  async whois(name) {
    const label = name.split(".")[0];
    const raw = this.names.get(label);
    const n = this.entry(label);
    const expiry = raw?.expiry ?? 0;
    return {
      name,
      label,
      registry: this.d.registry,
      status: n ? "REGISTERED" : "AVAILABLE",
      expiry,
      expiresAt: expiry ? new Date(expiry * 1000).toISOString() : null,
      owner: n ? n.owner : null,
      latestOwner: raw?.owner ?? null,
      tokenId: hex(this.tokenIdOf(label, raw)),
      canonicalId: hex(BigInt(labelhash(label)) & ~low32),
      resource: hex(this.resourceOf(label, raw)),
      registrationEpoch: n ? raw.epoch : null,
      hasRegistrationHistory: (raw?.version ?? 0) !== 0,
      resolver: n?.resolver ?? null,
      subregistry: null,
    };
  }
  async resolverInfo(name) {
    const label = name.split(".")[0];
    const n = this.entry(label);
    const resolver = n?.resolver ?? null;
    return { name, dns: "0x00", resolver, node: namehash(name), offset: 0, kind: resolver ? "own" : "none", inheritedFrom: null, registry: this.d.registry, registryResolver: resolver, consistent: true };
  }
  async forwardAddress(name) {
    if (this.lookupFailures.has("addr")) return { status: "lookup_failed", value: null, error: "mock outage" };
    const label = name.split(".")[0];
    const n = this.entry(label);
    if (!n?.resolver) return { status: "absent", value: null };
    const rec = this.records.get(namehash(name));
    return rec?.addr ? { status: "present", value: rec.addr } : { status: "absent", value: null };
  }
  async currentRecords(name, keys) {
    const addr = await this.forwardAddress(name);
    const label = name.split(".")[0];
    const n = this.entry(label);
    const rec = n?.resolver ? this.records.get(namehash(name)) : null;
    const texts = {};
    for (const k of keys) {
      if (this.lookupFailures.has(k)) texts[k] = { status: "lookup_failed", value: null, error: "mock outage" };
      else texts[k] = rec?.texts?.[k] ? { status: "present", value: rec.texts[k] } : { status: "absent", value: null };
    }
    return { addr, texts };
  }
  async adapterImplementation() {
    return this.adapterImpl;
  }
  async agentInfo(name, agentId) {
    const w = await this.whois(name);
    const a = this.agents.find((x) => x.agentId === agentId);
    const unbound = !a;
    const registryMatches = !unbound && isAddressEqual(a.tokenContract, this.d.registry);
    const orphaned = !unbound && registryMatches && a.tokenId !== BigInt(w.tokenId);
    const key = ensip25Key(this.d.chainId, this.d.identityRegistry, agentId.toString());
    const rec = this.records.get(namehash(name));
    return {
      ensip25Key: key,
      ensip25Linked: this.lookupFailures.has(key) ? null : !!rec?.texts?.[key],
      name,
      agentId: agentId.toString(),
      registry: this.d.registry,
      adapter: this.d.adapter8004,
      binding: { standard: a?.standard ?? 0, tokenContract: a?.tokenContract ?? zeroAddress, tokenId: hex(a?.tokenId ?? 0n) },
      currentTokenId: w.tokenId,
      orphaned,
      registryMatches,
      ownerIsController: !unbound && !orphaned && !!w.owner && isAddressEqual(w.owner, a.registeredBy),
      nftHolder: unbound ? zeroAddress : this.d.adapter8004,
      nftHeldByAdapter: !unbound,
      agentURI: a?.uri ?? "",
      status: unbound ? "unbound" : orphaned ? "orphaned" : "bound",
    };
  }
  async findAgentIds(name) {
    const w = await this.whois(name);
    const current = BigInt(w.tokenId);
    const hits = this.agents.filter((a) => isAddressEqual(a.tokenContract, this.d.registry) && a.tokenId >> 32n === current >> 32n).reverse();
    const registeredBy = {};
    for (const a of hits) registeredBy[a.agentId.toString()] = a.registeredBy;
    return { agentIds: hits.map((a) => a.agentId), registeredBy, scannedFrom: 0n, scannedTo: this.block };
  }
  async bindingMetadata(agentId) {
    return this.agents.some((a) => a.agentId === agentId) ? this.d.adapter8004 : null;
  }
  async receipt(hash) {
    return this.receipts.get(hash) ?? null;
  }

  // ---- the wallet: apply calldata as the deployed contracts would ----------

  apply(from, calldata) {
    const hash = keccak256(toHex(`tx:${++this.txCount}`));
    const logs = [];
    let status = "success";
    let fn = "?";
    try {
      fn = this.execute(from, calldata, logs);
    } catch (e) {
      status = "reverted";
      fn = `${fn} (reverted: ${e.message})`;
    }
    this.block += 1n;
    this.time += 12;
    this.applied.push({ to: calldata.to, fn, from, status });
    this.receipts.set(hash, { status, blockNumber: this.block, blockHash: keccak256(hash), from, to: calldata.to, gasUsed: 100000n, effectiveGasPrice: 1n, logs });
    return { hash, status };
  }

  execute(from, calldata, logs) {
    const d = this.d;
    const to = calldata.to.toLowerCase();
    if (to === d.resolverFactory.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: verifiableFactoryAbi, data: calldata.data });
      if (functionName !== "deployProxy") throw new Error(`unexpected ${functionName}`);
      const init = decodeFunctionData({ abi: permissionedResolverAbi, data: args[2] });
      const admin = init.args[0];
      const predicted = this.predicted(from);
      if (!isAddressEqual(admin, from)) throw new Error("admin != deployer");
      if (this.resolvers.has(predicted.toLowerCase())) throw new Error("CREATE2 collision: code already at address");
      this.resolvers.set(predicted.toLowerCase(), { owner: admin, verified: true });
      return "deployProxy";
    }
    if (to === d.registrar.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: ethRegistrarAbi, data: calldata.data });
      if (functionName === "commit") {
        const c = args[0];
        const t0 = this.commitments.get(c);
        if (t0 && this.time < t0 + this.maxAge) throw new Error("UnexpiredCommitmentExists");
        this.commitments.set(c, this.time);
        return "commit";
      }
      if (functionName === "register") {
        const [label, owner, secret, subregistry, resolver, duration, token, referrer] = args;
        const c = this.makeCommitment({ label, owner, secret, subregistry, resolver, durationSeconds: duration, referrer });
        const t0 = this.commitments.get(c);
        if (!t0) throw new Error("CommitmentTooNew(unknown)");
        if (this.time < t0 + this.minAge) throw new Error("CommitmentTooNew");
        if (this.time >= t0 + this.maxAge) throw new Error("CommitmentTooOld");
        if (this.entry(label)) throw new Error("NameNotAvailable");
        if (Number(duration) < this.minDuration) throw new Error("DurationTooShort");
        if (!isAddressEqual(token, d.paymentToken)) throw new Error("bad payment token");
        const bal = this.balances.get(from.toLowerCase()) ?? 0n;
        const allowance = this.allowances.get(from.toLowerCase()) ?? 0n;
        if (bal < this.price) throw new Error("insufficient balance");
        if (allowance < this.price) throw new Error("insufficient allowance");
        this.balances.set(from.toLowerCase(), bal - this.price);
        this.allowances.set(from.toLowerCase(), allowance - this.price);
        const prev = this.names.get(label);
        this.names.set(label, { owner, expiry: this.time + Number(duration), version: prev ? prev.version + 1 : 0, epoch: (prev?.epoch ?? 0) + 1, resolver });
        this.commitments.delete(c);
        return "register";
      }
      throw new Error(`unexpected ${functionName}`);
    }
    if (to === d.paymentToken.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: calldata.data });
      if (functionName !== "approve") throw new Error(`unexpected ${functionName}`);
      if (!isAddressEqual(args[0], d.registrar)) throw new Error("approve spender is not the registrar");
      this.allowances.set(from.toLowerCase(), args[1]);
      return "approve";
    }
    if (to === d.adapter8004.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: adapter8004Abi, data: calldata.data });
      if (functionName !== "register") throw new Error(`unexpected ${functionName}`);
      const [standard, tokenContract, tokenId, uri] = args;
      if (!isAddressEqual(tokenContract, d.registry)) throw new Error("wrong token contract");
      const label = [...this.names.keys()].find((l) => this.tokenIdOf(l, this.names.get(l)) === tokenId);
      const n = label ? this.entry(label) : null;
      if (!n || !isAddressEqual(n.owner, from)) throw new Error("NotController");
      const agentId = this.nextAgentId++;
      this.agents.push({ agentId, standard, tokenContract, tokenId, registeredBy: from, uri });
      const topics = encodeEventTopics({ abi: [AGENT_BOUND], eventName: "AgentBound", args: { agentId, standard, tokenContract } });
      const data = encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [tokenId, from]);
      logs.push({ address: d.adapter8004, data, topics });
      // Sanity: the plugin's decoder must read this back.
      const ev = decodeEventLog({ abi: [AGENT_BOUND], data, topics });
      if (ev.args.agentId !== agentId) throw new Error("mock log encoding broken");
      return "adapter.register";
    }
    const res = this.resolvers.get(to);
    if (res) {
      if (!isAddressEqual(res.owner, from)) throw new Error("resolver: not admin");
      const { functionName, args } = decodeFunctionData({ abi: resolverAbi, data: calldata.data });
      const calls = functionName === "multicall" ? args[0] : [calldata.data];
      for (const c of calls) {
        const inner = decodeFunctionData({ abi: resolverAbi, data: c });
        const node = inner.args[0];
        const rec = this.records.get(node) ?? { addr: null, texts: {} };
        if (inner.functionName === "setAddr") rec.addr = inner.args[1];
        else if (inner.functionName === "setText") rec.texts[inner.args[1]] = inner.args[2];
        else throw new Error(`unexpected ${inner.functionName}`);
        this.records.set(node, rec);
      }
      return `multicall(${calls.length})`;
    }
    throw new Error(`unknown target ${calldata.to}`);
  }
}

/** A second "endpoint" over the same state, optionally lying about one field. */
export function secondEndpoint(chain, lie) {
  return new Proxy(chain, {
    get(target, prop) {
      if (lie && prop === lie.method) return async (...a) => lie.answer(await target[prop](...a));
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * The wallet executor. `killAfter` freezes the process right after the
 * transaction landed (the receipt exists, the job file was never updated);
 * `killBefore` freezes it before anything was broadcast; `throwAfter` lets the
 * transaction land and then throws, which is the live network-drop case.
 */
export function mockExecutor(chain, owner, opts = {}) {
  const calls = [];
  let reached;
  const reachedPromise = new Promise((r) => (reached = r));
  const submit = async (req) => {
    calls.push(req.step);
    if (opts.killBefore === req.step) {
      reached();
      return new Promise(() => {});
    }
    const { hash, status } = chain.apply(owner, req.calldata);
    if (opts.killAfter === req.step) {
      reached();
      return new Promise(() => {});
    }
    if (opts.throwAfter === req.step) throw new Error("Remote signing request failed (network error)");
    return { hash, status: status === "success" ? "CONFIRMED" : "FAILED", ...(status === "reverted" ? { failureCode: "rpc_reverted", failureDescription: "execution reverted" } : {}), walletJobId: `wjob-${calls.length}` };
  };
  return { submit, calls, reached: reachedPromise };
}
