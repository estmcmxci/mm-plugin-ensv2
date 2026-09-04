/**
 * ERC-8004 agent identity via Adapter8004 (v0.5). Pure; no SDK import.
 *
 * The adapter mints an agent on the canonical ERC-8004 IdentityRegistry and
 * binds it to a token the caller controls. For an ENSv2 name that token is
 * the name's entry in the registry that holds it, identified by its CURRENT
 * token id from getState(). Two facts govern everything here:
 *
 *  1. Locate the holding registry with UR.findParentRegistry and take the
 *     token id from getState(), never a hand-masked canonical id. A subname's
 *     entry lives in its parent's subregistry; the root registry returns a
 *     plausible-looking wrong answer for it. (ensemble shipped that bug.)
 *  2. The token id is NOT stable: any role grant or revoke on the name
 *     regenerates it, leaving the binding pointing at a stale id. That is
 *     D-012's stated v0 limitation ("feature-gated to token-ID bindings")
 *     until the upstream resource-anchored standard lands. agentInfo()
 *     therefore reports `orphaned` by comparing the bound token id with the
 *     name's current one — D-010's detection.
 *
 * Control: the adapter's ERC721 check calls tokenContract.ownerOf(tokenId);
 * the ENSv2 registry is an ERC-1155 singleton that exposes ownerOf(), so
 * TokenStandard.ERC721 is the value that works (WS04 rehearsal, ensemble).
 */
import { decodeEventLog, encodeFunctionData, isAddressEqual, parseAbiItem, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { TOKEN_STANDARD, adapter8004Abi, identityRegistryAbi } from "./abis.js";
import type { EnsV2Deployment } from "./deployments.js";
import { ensip25Key } from "./erc7930.js";
import { ReadError, ensClient, whois, type WhoisInfo } from "./reads.js";
import type { Calldata } from "./registrar.js";

export const AGENT_BOUND = parseAbiItem(
  "event AgentBound(uint256 indexed agentId, uint8 indexed standard, address indexed tokenContract, uint256 tokenId, address registeredBy)",
);

export type BindPlan = {
  name: string;
  owner: Address;
  /** The registry holding the name's entry — the token contract we bind to. */
  tokenContract: Address;
  /** Current token id from getState(). Mutable; see header. */
  tokenId: bigint;
  standard: number;
  agentURI: string;
  whois: WhoisInfo;
  calldata: Calldata;
};

/** Preconditions + calldata for adapter.register(). Throws ReadError when the name is not bindable by this owner. */
export async function bindPlan(client: PublicClient, d: EnsV2Deployment, name: string, owner: Address, agentURI: string): Promise<BindPlan> {
  if (!agentURI || !/^(https?:\/\/|ipfs:\/\/)\S+$/i.test(agentURI)) {
    throw new ReadError("ENSV2_INVALID_AGENT_URI", `'${agentURI}' is not an http(s):// or ipfs:// URI.`, "ERC-8004 verifiers dereference agentURI expecting a registration JSON.");
  }
  const w = await whois(client, d, name);
  if (w.status !== "REGISTERED") {
    throw new ReadError("ENSV2_NAME_NOT_REGISTERED", `${w.name} is ${w.status}; only a registered name can be bound.`, "Register it first with `ensv2 register`.");
  }
  if (!w.owner || !isAddressEqual(w.owner, owner)) {
    throw new ReadError("ENSV2_NOT_OWNER", `${w.name} is owned by ${w.owner ?? "nobody"}, not this wallet (${owner}).`, "The adapter's control check requires the token owner to call register().");
  }
  const tokenId = BigInt(w.tokenId);
  const data = encodeFunctionData({
    abi: adapter8004Abi,
    functionName: "register",
    args: [TOKEN_STANDARD.ERC721, w.registry, tokenId, agentURI],
  });
  return {
    name: w.name,
    owner,
    tokenContract: w.registry,
    tokenId,
    standard: TOKEN_STANDARD.ERC721,
    agentURI,
    whois: w,
    calldata: { to: d.adapter8004, data, value: 0n },
  };
}

/** Pull the agentId out of a register() receipt. */
export function agentIdFromReceipt(receipt: Pick<TransactionReceipt, "logs">, adapter: Address): bigint | null {
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, adapter)) continue;
    try {
      const ev = decodeEventLog({ abi: [AGENT_BOUND], data: log.data, topics: log.topics });
      if (ev.eventName === "AgentBound") return ev.args.agentId;
    } catch {
      /* not our event */
    }
  }
  return null;
}

export type AgentInfo = {
  name: string;
  agentId: string;
  registry: Address;
  adapter: Address;
  /** What the adapter says the agent is bound to. */
  binding: { standard: number; tokenContract: Address; tokenId: Hex };
  /** The name's CURRENT token id. */
  currentTokenId: Hex;
  /** bound tokenId != current tokenId — a role change (or re-registration) regenerated the id. D-010. */
  orphaned: boolean;
  /** Same registry contract as the name's holding registry. */
  registryMatches: boolean;
  /** isController(agentId, owner) as the adapter evaluates it right now. */
  ownerIsController: boolean;
  /** ownerOf(agentId) on the identity registry — the adapter holds bound agents. */
  nftHolder: Address;
  nftHeldByAdapter: boolean;
  agentURI: string;
  status: "bound" | "orphaned" | "unbound";
  /** ENSIP-25: agent-registration[<erc7930 identityRegistry>][<agentId>] on the name, read through the UR. */
  ensip25Key: string;
  /** true = non-empty (spec: verified); false = absent/empty; null = lookup failed. */
  ensip25Linked: boolean | null;
};

/** Everything the chain says about one agent id relative to a name. */
export async function agentInfo(client: PublicClient, d: EnsV2Deployment, name: string, agentId: bigint): Promise<AgentInfo> {
  const w = await whois(client, d, name);
  const [binding, isCtrl, holder, uri] = await Promise.all([
    client.readContract({ address: d.adapter8004, abi: adapter8004Abi, functionName: "bindingOf", args: [agentId] }),
    w.owner ? client.readContract({ address: d.adapter8004, abi: adapter8004Abi, functionName: "isController", args: [agentId, w.owner] }) : Promise.resolve(false),
    client.readContract({ address: d.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    client.readContract({ address: d.adapter8004, abi: adapter8004Abi, functionName: "tokenURI", args: [agentId] }),
  ]);
  const unbound = isAddressEqual(binding.tokenContract, "0x0000000000000000000000000000000000000000");
  const registryMatches = !unbound && isAddressEqual(binding.tokenContract, w.registry);
  const orphaned = !unbound && registryMatches && binding.tokenId !== BigInt(w.tokenId);

  // ENSIP-25 verification flow, registry -> ENS: build the key, resolve the text record, non-empty == verified.
  const key = ensip25Key(d.chainId, d.identityRegistry, agentId.toString());
  let linked: boolean | null;
  try {
    const v = await ensClient(client, d.chainId).getEnsText({ name: w.name, key, universalResolverAddress: d.universalResolver });
    linked = !!v;
  } catch {
    linked = null;
  }

  return {
    ensip25Key: key,
    ensip25Linked: linked,
    name: w.name,
    agentId: agentId.toString(),
    registry: w.registry,
    adapter: d.adapter8004,
    binding: { standard: binding.standard, tokenContract: binding.tokenContract, tokenId: `0x${binding.tokenId.toString(16)}` },
    currentTokenId: w.tokenId,
    orphaned,
    registryMatches,
    ownerIsController: isCtrl,
    nftHolder: holder,
    nftHeldByAdapter: isAddressEqual(holder, d.adapter8004),
    agentURI: uri,
    status: unbound ? "unbound" : orphaned ? "orphaned" : "bound",
  };
}

/**
 * Find agent ids bound to a name by scanning AgentBound logs on the adapter,
 * filtered by the indexed tokenContract and matched on the (unindexed) token
 * id. Bounded scan, newest first; stops at the first hit unless `all`.
 * O(chunks) RPC calls — acceptable for the Sepolia beta; v0.4's ENSIP-25
 * record makes this O(1) for names that publish it.
 */
export async function findAgentIdsForName(
  client: PublicClient,
  d: EnsV2Deployment,
  name: string,
  opts: { maxChunks?: number; chunk?: bigint; all?: boolean } = {},
): Promise<{ agentIds: bigint[]; scannedFrom: bigint; scannedTo: bigint; currentTokenId: bigint }> {
  const w = await whois(client, d, name);
  const current = BigInt(w.tokenId);
  const chunk = opts.chunk ?? 9999n;
  const maxChunks = opts.maxChunks ?? 60;
  const latest = await client.getBlockNumber();
  const found: bigint[] = [];
  let hi = latest;
  let lo = hi;
  for (let i = 0; i < maxChunks && hi > 0n; i++) {
    lo = hi > chunk ? hi - chunk : 0n;
    const logs = await client.getLogs({ address: d.adapter8004, event: AGENT_BOUND, args: { tokenContract: w.registry }, fromBlock: lo, toBlock: hi });
    for (const l of logs.reverse()) {
      // Match the name's canonical id (upper 224 bits): the bound id may be a stale version of the same name.
      if ((l.args.tokenId! >> 32n) === (current >> 32n)) found.push(l.args.agentId!);
    }
    if (found.length && !opts.all) break;
    hi = lo - 1n;
  }
  return { agentIds: found, scannedFrom: lo, scannedTo: latest, currentTokenId: current };
}
