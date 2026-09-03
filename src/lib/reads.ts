/**
 * Read-surface logic for v0.1: resolve, whois, resolver.
 *
 * Deliberately free of any @metamask/agent-wallet import so it can be run
 * against a plain viem client (scripts/check.mjs) without the host. Commands
 * are thin wrappers that map ReadError -> CommandError.
 *
 * Correctness notes, each traceable to the ENS docs or the deployed contracts:
 *  - Locate the registry that HOLDS a name with UR.findParentRegistry, never
 *    by assuming the .eth registry. A subname's entry lives in its parent's
 *    subregistry; reading the root for it returns a plausible-looking
 *    "AVAILABLE" for a name that is in fact registered.
 *  - getState().latestOwner is stale after expiry (it bypasses the
 *    expiry-aware ownerOf). Report `owner` only while REGISTERED.
 *  - tokenId is not a stable identifier; it changes on any role grant or
 *    revoke. Surface it, but also surface the canonical id and the
 *    registration epoch (low 32 bits of `resource`), which is the durable
 *    anchor. The epoch is only meaningful while REGISTERED — when expired the
 *    registry reports eacVersionId + 1, a scope that does not yet exist.
 *  - findResolver's `offset` is the signal for "this name's own resolver"
 *    (0) versus "inherited from an ancestor suffix" (non-zero).
 */
import {
  createPublicClient,
  custom,
  hexToBytes,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { labelhash } from "viem/ens";
import { registryAbi, universalResolverAbi } from "./abis.js";
import type { EnsV2Deployment } from "./deployments.js";
import { V2Status } from "./ensv2.js";
import { dnsDecode, dnsEncode, leafLabel, normalizeName } from "./names.js";

export class ReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ReadError";
  }
}

/**
 * The host-provided client carries no `chain`, so viem's ENS actions cannot
 * find the Universal Resolver on it. Reuse its transport (and therefore the
 * host's authenticated RPC) under a chain-aware client. Same pattern as
 * MetaMask/agent-wallet-plugin-examples#5.
 */
export function ensClient(host: PublicClient, chainId: number): PublicClient {
  if (chainId !== sepolia.id) {
    throw new ReadError("ENSV2_UNSUPPORTED_CHAIN", `No chain definition for chain ${chainId}.`, "ENSv2 is Sepolia-only (11155111).");
  }
  return createPublicClient({ chain: sepolia, transport: custom(host.transport) });
}

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
const orNull = (a: Address): Address | null => (isAddressEqual(a, zeroAddress) ? null : a);

// ---------------------------------------------------------------------------
// resolver

export type ResolverKind = "own" | "inherited" | "none";

export type ResolverInfo = {
  name: string;
  dns: Hex;
  resolver: Address | null;
  node: Hex;
  offset: number;
  kind: ResolverKind;
  /** The ancestor whose resolver answers for this name, when `kind` is "inherited". */
  inheritedFrom: string | null;
  /** The registry that holds this name's entry, or null if none does. */
  registry: Address | null;
  /** What that registry's own entry says the resolver is. */
  registryResolver: Address | null;
  /** UR and registry agree. null when not comparable (inherited, or no registry). */
  consistent: boolean | null;
};

export async function resolverInfo(client: PublicClient, d: EnsV2Deployment, rawName: string): Promise<ResolverInfo> {
  const name = normalizeName(rawName);
  const dns = dnsEncode(name);

  const found = await client.readContract({
    address: d.universalResolver,
    abi: universalResolverAbi,
    functionName: "findResolver",
    args: [dns],
  });
  const offset = Number(found.offset);
  const kind: ResolverKind = isAddressEqual(found.resolver, zeroAddress) ? "none" : offset === 0 ? "own" : "inherited";
  const inheritedFrom = kind === "inherited" ? dnsDecode(hexToBytes(dns), offset) : null;

  const registryAddr = await client.readContract({
    address: d.universalResolver,
    abi: universalResolverAbi,
    functionName: "findParentRegistry",
    args: [dns],
  });
  const registry = orNull(registryAddr);

  let registryResolver: Address | null = null;
  if (registry) {
    registryResolver = orNull(
      await client.readContract({ address: registry, abi: registryAbi, functionName: "getResolver", args: [leafLabel(name)] }),
    );
  }

  let consistent: boolean | null = null;
  if (kind === "own" && registryResolver) consistent = isAddressEqual(registryResolver, found.resolver);
  else if (kind === "none" && registry) consistent = registryResolver === null;

  return { name, dns, resolver: orNull(found.resolver), node: found.node, offset, kind, inheritedFrom, registry, registryResolver, consistent };
}

// ---------------------------------------------------------------------------
// whois

export type WhoisInfo = {
  name: string;
  label: string;
  /** The registry holding this name's entry. */
  registry: Address;
  status: keyof typeof V2Status;
  expiry: number;
  expiresAt: string | null;
  /** Owner while REGISTERED; null otherwise (latestOwner is stale after expiry). */
  owner: Address | null;
  latestOwner: Address | null;
  /** Current ERC-1155 token id. NOT stable — changes on any role grant/revoke. Re-read before use, never cache. */
  tokenId: Hex;
  /** labelhash with the low 32 bits cleared — the registry's storage key. Stable. */
  canonicalId: Hex;
  resource: Hex;
  /** eacVersionId, the registration epoch. The durable identity anchor together with (registry, canonicalId). Only meaningful while REGISTERED. */
  registrationEpoch: number | null;
  /** Non-zero token version => this label was registered in v2 before (explicit unregister bumps it). */
  hasRegistrationHistory: boolean;
  resolver: Address | null;
  subregistry: Address | null;
};

export async function whois(client: PublicClient, d: EnsV2Deployment, rawName: string): Promise<WhoisInfo> {
  const name = normalizeName(rawName);
  const dns = dnsEncode(name);

  const registryAddr = await client.readContract({
    address: d.universalResolver,
    abi: universalResolverAbi,
    functionName: "findParentRegistry",
    args: [dns],
  });
  if (isAddressEqual(registryAddr, zeroAddress)) {
    throw new ReadError(
      "ENSV2_NAME_NOT_FOUND",
      `No ENSv2 registry holds "${name}".`,
      "For a 2LD the name must be under .eth. For a subname, the parent must have a subregistry set.",
    );
  }

  const label = leafLabel(name);
  const anyId = BigInt(labelhash(label));
  const [state, resolver, subregistry] = await Promise.all([
    client.readContract({ address: registryAddr, abi: registryAbi, functionName: "getState", args: [anyId] }),
    client.readContract({ address: registryAddr, abi: registryAbi, functionName: "getResolver", args: [label] }),
    client.readContract({ address: registryAddr, abi: registryAbi, functionName: "getSubregistry", args: [label] }),
  ]);

  const status = state.status as V2Status;
  const registered = status === V2Status.REGISTERED;
  const expiry = Number(state.expiry);

  return {
    name,
    label,
    registry: registryAddr,
    status: V2Status[status] as keyof typeof V2Status,
    expiry,
    expiresAt: expiry > 0 ? new Date(expiry * 1000).toISOString() : null,
    owner: registered ? orNull(state.latestOwner) : null,
    latestOwner: orNull(state.latestOwner),
    tokenId: hex(state.tokenId),
    canonicalId: hex(anyId ^ (anyId & 0xffff_ffffn)),
    resource: hex(state.resource),
    registrationEpoch: registered ? Number(state.resource & 0xffff_ffffn) : null,
    hasRegistrationHistory: (state.tokenId & 0xffff_ffffn) !== 0n,
    resolver: orNull(resolver),
    subregistry: orNull(subregistry),
  };
}

// ---------------------------------------------------------------------------
// resolve

export type ResolveResult = {
  input: string;
  kind: "name" | "address";
  name: string | null;
  address: Address | null;
  resolver: Address | null;
  /** 0 = the name's own resolver answered; >0 = inherited from an ancestor. null for reverse lookups. */
  offset: number | null;
};

export async function resolveQuery(client: PublicClient, d: EnsV2Deployment, chainId: number, query: string): Promise<ResolveResult> {
  const ens = ensClient(client, chainId);

  if (isAddress(query)) {
    // Reverse: UR.reverse verifies the forward record matches on-chain, so a
    // non-null answer here has already passed the ENSIP-19 round-trip.
    const name = await ens.getEnsName({ address: query, universalResolverAddress: d.universalResolver });
    return { input: query, kind: "address", name, address: query, resolver: null, offset: null };
  }

  const name = normalizeName(query);
  const [address, info] = await Promise.all([
    ens.getEnsAddress({ name, universalResolverAddress: d.universalResolver }),
    resolverInfo(client, d, name),
  ]);
  return { input: query, kind: "name", name, address, resolver: info.resolver, offset: info.offset };
}
