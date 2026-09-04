/**
 * Resolver records for an agent name (v0.4). Pure; no SDK import.
 *
 * Keys and rules come from the specs, not from any prior implementation:
 *   ENSIP-1   addr(node) — coinType 60
 *   ENSIP-5   text records; global keys lowercase; empty string == absent
 *   ENSIP-12  avatar: https:// | ipfs:// | data:image/... | eip155:<id>/erc721|erc1155:<addr>/<tokenId>,
 *             MUST resolve to an image directly
 *   ENSIP-18  description <= 160 chars; alias replaces legacy `name`; url http(s)
 *   ENSIP-25  agent-registration[<erc7930 registry>][<agentId>] = "1"; agentId has no [ ]
 *   ENSIP-26  agent-context (free-form) and agent-endpoint[<protocol>] (URL; mcp | a2a | web)
 *
 * Reads go through the Universal Resolver (UR.resolve), never the resolver
 * directly, so a value is only reported present if it is actually reachable
 * for the name (conformance check 6). Each read is three-state: present /
 * absent / lookup_failed — an RPC outage must not look like "no record".
 *
 * Writes are batched into one resolver multicall so one approval covers the
 * whole record set, and only keys whose on-chain value differs are written.
 */
import { encodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { namehash } from "viem/ens";
import { resolverAbi } from "./abis.js";
import type { EnsV2Deployment } from "./deployments.js";
import { ensip25Key, parseEnsip25Key, type Ensip25Ref } from "./erc7930.js";
import { normalizeName } from "./names.js";
import { ReadError, ensClient, resolverInfo } from "./reads.js";
import { ownedResolverStatus } from "./resolver.js";
import type { Calldata } from "./registrar.js";

// ---------------------------------------------------------------------------
// keys

export const PROFILE_KEYS = ["description", "url", "avatar", "alias", "display", "email", "keywords", "notice", "location"] as const;
export const AGENT_KEYS = ["agent-context", "agent-endpoint[mcp]", "agent-endpoint[a2a]", "agent-endpoint[web]"] as const;
export const KNOWN_PROTOCOLS = ["mcp", "a2a", "web"] as const;
/** Non-standard ensemble-cli index; read for compatibility, never written. */
export const ENSEMBLE_AGENT_IDS_KEY = "agent-ids";

export const endpointKey = (protocol: string) => `agent-endpoint[${protocol}]`;

// ---------------------------------------------------------------------------
// validation (write side)

const URL_RE = /^(https?:\/\/|ipfs:\/\/)\S+$/i;
const AVATAR_RE = /^(https:\/\/\S+|ipfs:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|eip155:\d+\/erc(721|1155):0x[0-9a-fA-F]{40}\/\d+)$/;

export function validateProfile(values: Partial<Record<string, string>>): string[] {
  const errors: string[] = [];
  if (values.description != null && [...values.description].length > 160) errors.push("description exceeds 160 characters (ENSIP-18)");
  if (values.url != null && !/^https?:\/\/\S+$/i.test(values.url)) errors.push("url must be an http(s) URL (ENSIP-5/18)");
  if (values.avatar != null && !AVATAR_RE.test(values.avatar)) errors.push("avatar must be https://, ipfs://, data:image/…, or eip155:<chain>/erc721|erc1155:<address>/<id> (ENSIP-12)");
  if (values.email != null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push("email is not an address");
  return errors;
}

export function validateEndpoints(endpoints: Record<string, string>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [proto, url] of Object.entries(endpoints)) {
    if (!/^[a-z0-9-]+$/.test(proto)) errors.push(`endpoint protocol '${proto}' must be lowercase letters, digits, hyphens (ENSIP-26)`);
    else if (!(KNOWN_PROTOCOLS as readonly string[]).includes(proto)) warnings.push(`endpoint protocol '${proto}' is not one of ${KNOWN_PROTOCOLS.join("/")}; ENSIP-26 allows additions but clients may not know it`);
    if (!URL_RE.test(url)) errors.push(`agent-endpoint[${proto}] must be an http(s):// or ipfs:// URL (ENSIP-26)`);
  }
  return { errors, warnings };
}

/** Parse "mcp=https://a,web=https://b" */
export function parseEndpoints(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) throw new ReadError("ENSV2_INVALID_ENDPOINTS", `'${part}' is not <protocol>=<url>.`, "Example: --endpoints mcp=https://agent.example/mcp,web=https://agent.example");
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// reads (through the Universal Resolver)

export type RecordRead = { status: "present" | "absent" | "lookup_failed"; value: string | null; error?: string };

export async function readText(ens: PublicClient, d: EnsV2Deployment, name: string, key: string): Promise<RecordRead> {
  try {
    const v = await ens.getEnsText({ name, key, universalResolverAddress: d.universalResolver });
    return v ? { status: "present", value: v } : { status: "absent", value: null };
  } catch (error) {
    return { status: "lookup_failed", value: null, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

export async function readAddr(ens: PublicClient, d: EnsV2Deployment, name: string): Promise<RecordRead> {
  try {
    const a = await ens.getEnsAddress({ name, universalResolverAddress: d.universalResolver });
    return a && !isAddressEqual(a, zeroAddress) ? { status: "present", value: a } : { status: "absent", value: null };
  } catch (error) {
    return { status: "lookup_failed", value: null, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

export type RecordSet = {
  name: string;
  resolver: Address | null;
  addr: RecordRead;
  profile: Record<string, RecordRead>;
  agent: Record<string, RecordRead>;
  /** ENSIP-25 links found: the ones asked for via agentIds, plus any listed in an ensemble `agent-ids` index. */
  links: Array<Ensip25Ref & { read: RecordRead }>;
  warnings: string[];
};

export async function readRecordSet(
  client: PublicClient,
  d: EnsV2Deployment,
  rawName: string,
  opts: { agentIds?: string[]; registry?: Address } = {},
): Promise<RecordSet> {
  const name = normalizeName(rawName);
  const ens = ensClient(client, d.chainId);
  const info = await resolverInfo(client, d, name);
  const warnings: string[] = [];

  const [addr, ...rest] = await Promise.all([readAddr(ens, d, name), ...[...PROFILE_KEYS, ...AGENT_KEYS, ENSEMBLE_AGENT_IDS_KEY].map((k) => readText(ens, d, name, k))]);
  const profile: Record<string, RecordRead> = {};
  PROFILE_KEYS.forEach((k, i) => (profile[k] = rest[i]!));
  const agent: Record<string, RecordRead> = {};
  AGENT_KEYS.forEach((k, i) => (agent[k] = rest[PROFILE_KEYS.length + i]!));
  const agentIdsRead = rest[PROFILE_KEYS.length + AGENT_KEYS.length]!;

  // spec-level validation on what's there
  const desc = profile.description;
  if (desc?.value && [...desc.value].length > 160) warnings.push("description exceeds 160 characters (ENSIP-18)");
  if (profile.avatar?.value && !AVATAR_RE.test(profile.avatar.value)) warnings.push("avatar does not match ENSIP-12 grammar");
  if (profile.display?.value && profile.display.value.toLowerCase() !== name) warnings.push("display does not match the name when case-folded; clients ignore it (ENSIP-5)");
  for (const k of AGENT_KEYS) if (k.startsWith("agent-endpoint") && agent[k]?.value && !URL_RE.test(agent[k]!.value!)) warnings.push(`${k} is not a URL (ENSIP-26)`);

  // ENSIP-25 links: requested ids + ensemble index (compat, read-only)
  const registry = opts.registry ?? d.identityRegistry;
  const ids = new Set(opts.agentIds ?? []);
  if (agentIdsRead.status === "present") {
    try {
      const arr = JSON.parse(agentIdsRead.value!);
      if (Array.isArray(arr)) for (const x of arr) ids.add(String(x));
      warnings.push("agent-ids index present (ensemble-cli extension, not in ENSIP-25)");
    } catch {
      warnings.push("agent-ids record is not a JSON array");
    }
  }
  const links: RecordSet["links"] = [];
  for (const id of ids) {
    const key = ensip25Key(d.chainId, registry, id);
    const ref = parseEnsip25Key(key)!;
    links.push({ ...ref, read: await readText(ens, d, name, key) });
  }

  return { name, resolver: info.resolver, addr, profile, agent, links, warnings };
}

// ---------------------------------------------------------------------------
// writes

export type DesiredRecords = {
  addr?: Address;
  texts: Record<string, string>;
};

export type RecordsPlan = {
  name: string;
  node: Hex;
  resolver: Address;
  /** key -> {from, to}; only keys that actually change. "addr" is included as a pseudo-key. */
  changes: Record<string, { from: string | null; to: string }>;
  unchanged: string[];
  calldata: Calldata | null;
  calls: number;
};

/** Diff desired vs on-chain (via UR) and build a single resolver multicall for the difference. */
export async function planRecords(client: PublicClient, d: EnsV2Deployment, rawName: string, owner: Address, desired: DesiredRecords): Promise<RecordsPlan> {
  const name = normalizeName(rawName);
  const node = namehash(name);
  const ens = ensClient(client, d.chainId);

  // The resolver must be the name's own AND this wallet's (we hold ALL_ROLES on ours).
  const info = await resolverInfo(client, d, name);
  if (info.kind !== "own" || !info.resolver) {
    throw new ReadError("ENSV2_NO_OWN_RESOLVER", `${name} has ${info.kind === "inherited" ? `an inherited resolver (${info.inheritedFrom})` : "no resolver"}.`, "Run `ensv2 resolver deploy` and register the name with it, or assign it with the registry's setResolver.");
  }
  const mine = await ownedResolverStatus(client, d, owner);
  if (!isAddressEqual(info.resolver, mine.predicted)) {
    throw new ReadError("ENSV2_RESOLVER_NOT_OWNED", `${name}'s resolver is ${info.resolver}; this wallet's is ${mine.predicted}.`, "Records can only be written to a resolver this wallet administers.");
  }
  const resolver = info.resolver;

  const changes: RecordsPlan["changes"] = {};
  const unchanged: string[] = [];
  const calls: Hex[] = [];

  if (desired.addr) {
    const cur = await readAddr(ens, d, name);
    if (cur.status === "lookup_failed") throw new ReadError("ENSV2_LOOKUP_FAILED", `Could not read addr for ${name}: ${cur.error}`, "Retry; refusing to write over an unreadable record.");
    if (!cur.value || !isAddressEqual(getAddress(cur.value), desired.addr)) {
      changes.addr = { from: cur.value, to: desired.addr };
      calls.push(encodeFunctionData({ abi: resolverAbi, functionName: "setAddr", args: [node, desired.addr] }));
    } else unchanged.push("addr");
  }

  for (const [key, value] of Object.entries(desired.texts)) {
    const cur = await readText(ens, d, name, key);
    if (cur.status === "lookup_failed") throw new ReadError("ENSV2_LOOKUP_FAILED", `Could not read ${key} for ${name}: ${cur.error}`, "Retry; refusing to write over an unreadable record.");
    if (cur.value !== value) {
      changes[key] = { from: cur.value, to: value };
      calls.push(encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, key, value] }));
    } else unchanged.push(key);
  }

  const calldata: Calldata | null = calls.length
    ? { to: resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: "multicall", args: [calls] }), value: 0n }
    : null;

  return { name, node, resolver, changes, unchanged, calldata, calls: calls.length };
}

/** Default agent-context stub when none is provided and none exists. Markdown, per ENSIP-26's own example. */
export function defaultContext(name: string, description: string | undefined, endpoints: Record<string, string>, agentId: string | undefined): string {
  const lines = [`# ${name}`, ""];
  if (description) lines.push(description, "");
  if (Object.keys(endpoints).length) {
    lines.push("Connect via the `agent-endpoint` text records on this name:", "");
    for (const [p, u] of Object.entries(endpoints)) lines.push(`- ${p}: ${u}`);
    lines.push("");
  }
  if (agentId) lines.push(`ERC-8004 agent #${agentId}; see the \`agent-registration\` record (ENSIP-25).`, "");
  return lines.join("\n").trimEnd() + "\n";
}

export function isAddressLike(v: string | undefined): v is Address {
  return !!v && isAddress(v);
}
