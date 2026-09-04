/**
 * Primary names (reverse resolution) for ENSv2 on Sepolia.
 *
 * Per docs.ens.domains/ensv2/reverse-resolution, "At Launch": the reverse
 * namespace (`addr.reverse`, `default.reverse`) stays on v1 infrastructure.
 * The v2 root registry binds the `reverse` TLD to ENSV1Resolver, which mirrors
 * the v1 registry, so UR.reverse(addr, 60) reads `<addr>.addr.reverse` from
 * v1 — and the write is the v1 ReverseRegistrar.setName(name), sent by the
 * address itself (msg.sender is the only authorization for an EOA).
 *
 * Nothing here trusts the deployment table for the registrar. It is
 * re-derived from the v2 root on every call:
 *   root.getResolver("reverse") → ENSV1Resolver.REGISTRY_V1()
 *     → v1Registry.owner(namehash("addr.reverse")) == d.reverseRegistrar
 * and the command refuses to send if the two disagree. When ENS migrates the
 * reverse namespace to v2-native contracts (the docs' "upcoming"
 * L2ReverseRegistrar), this derivation stops matching and the command fails
 * closed instead of writing to the wrong place.
 *
 * Free of any @metamask/agent-wallet import so scripts/check.mjs can run it.
 */
import { encodeFunctionData, getAddress, isAddressEqual, namehash, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ensV1RegistryAbi, ensV1ResolverAbi, nameResolverAbi, registryAbi, reverseRegistrarAbi } from "./abis.js";
import type { EnsV2Deployment } from "./deployments.js";
import { normalizeName } from "./names.js";
import { ReadError, ensClient } from "./reads.js";

export const ADDR_REVERSE_NODE: Hex = namehash("addr.reverse");

export type ReverseInfra = {
  /** Resolver the v2 root binds to the `reverse` TLD (ENSV1Resolver at launch). */
  reverseTldResolver: Address;
  /** The v1 ENS registry that resolver mirrors. */
  v1Registry: Address;
  /** owner(addr.reverse) in that registry — the contract that accepts setName(). */
  reverseRegistrar: Address;
  /** Resolver the registrar assigns to a claimed reverse node. */
  defaultResolver: Address;
  /** Derived registrar == deployment table. Writes refuse when false. */
  matchesConfig: boolean;
};

export async function reverseInfra(client: PublicClient, d: EnsV2Deployment): Promise<ReverseInfra> {
  const reverseTldResolver = await client.readContract({ address: d.rootRegistry, abi: registryAbi, functionName: "getResolver", args: ["reverse"] });
  if (reverseTldResolver === zeroAddress) {
    throw new ReadError("ENSV2_REVERSE_UNBOUND", "The ENSv2 root registry has no resolver for the `reverse` TLD.", "Reverse resolution is not wired on this deployment; refusing to guess a registrar.");
  }
  let v1Registry: Address;
  try {
    v1Registry = await client.readContract({ address: reverseTldResolver, abi: ensV1ResolverAbi, functionName: "REGISTRY_V1" });
  } catch {
    throw new ReadError(
      "ENSV2_REVERSE_MIGRATED",
      `The \`reverse\` TLD resolver ${reverseTldResolver} is not the v1 mirror (no REGISTRY_V1()).`,
      "The reverse namespace may have moved to v2-native contracts. This plugin version only knows the launch layout; refusing rather than writing to the wrong registrar.",
    );
  }
  const reverseRegistrar = await client.readContract({ address: v1Registry, abi: ensV1RegistryAbi, functionName: "owner", args: [ADDR_REVERSE_NODE] });
  if (reverseRegistrar === zeroAddress) {
    throw new ReadError("ENSV2_REVERSE_UNOWNED", "Nobody owns `addr.reverse` in the mirrored v1 registry.", "No reverse registrar to call; refusing.");
  }
  const defaultResolver = await client.readContract({ address: reverseRegistrar, abi: reverseRegistrarAbi, functionName: "defaultResolver" });
  return { reverseTldResolver, v1Registry, reverseRegistrar, defaultResolver, matchesConfig: isAddressEqual(reverseRegistrar, d.reverseRegistrar) };
}

export type PrimaryStatus = {
  address: Address;
  /** namehash(<addr>.addr.reverse), as the registrar computes it. */
  reverseNode: Hex;
  /** Resolver set on that node in the v1 registry; null = never claimed. */
  v1Resolver: Address | null;
  /** What the reverse record literally says. Unverified. */
  rawName: string | null;
  /** What rawName forward-resolves to through the Universal Resolver. */
  forwardAddress: Address | null;
  /** UR.reverse() — non-null only when the forward round-trip matches. This is what everyone else sees. */
  primaryName: string | null;
  functional: boolean;
  infra: ReverseInfra;
};

export async function primaryStatus(client: PublicClient, d: EnsV2Deployment, chainId: number, address: string): Promise<PrimaryStatus> {
  const addr = getAddress(address);
  const infra = await reverseInfra(client, d);
  const reverseNode = await client.readContract({ address: infra.reverseRegistrar, abi: reverseRegistrarAbi, functionName: "node", args: [addr] });
  const v1ResolverRaw = await client.readContract({ address: infra.v1Registry, abi: ensV1RegistryAbi, functionName: "resolver", args: [reverseNode] });
  const v1Resolver = v1ResolverRaw === zeroAddress ? null : v1ResolverRaw;

  let rawName: string | null = null;
  if (v1Resolver) {
    try {
      const n = await client.readContract({ address: v1Resolver, abi: nameResolverAbi, functionName: "name", args: [reverseNode] });
      rawName = n === "" ? null : n;
    } catch {
      rawName = null;
    }
  }

  const ens = ensClient(client, chainId);
  const [forwardAddress, primaryName] = await Promise.all([
    rawName ? ens.getEnsAddress({ name: rawName, universalResolverAddress: d.universalResolver }).catch(() => null) : Promise.resolve(null),
    ens.getEnsName({ address: addr, universalResolverAddress: d.universalResolver }).catch(() => null),
  ]);
  return { address: addr, reverseNode, v1Resolver, rawName, forwardAddress, primaryName, functional: primaryName !== null, infra };
}

export type PrimaryPlan = {
  owner: Address;
  name: string;
  status: PrimaryStatus;
  /** Already the functional primary name — nothing to send. */
  alreadySet: boolean;
  calldata: { to: Address; data: Hex; value: bigint } | null;
};

/**
 * Plan `ReverseRegistrar.setName(name)` for `owner`. Refuses unless the
 * derived registrar matches the table and `name` already forward-resolves to
 * `owner` through the Universal Resolver — a reverse record that does not
 * round-trip is ignored by every resolver, so writing it would only cost gas.
 */
export async function planSetPrimary(client: PublicClient, d: EnsV2Deployment, chainId: number, ownerAddress: string, rawInput: string): Promise<PrimaryPlan> {
  const owner = getAddress(ownerAddress);
  const name = normalizeName(rawInput);
  const status = await primaryStatus(client, d, chainId, owner);
  if (!status.infra.matchesConfig) {
    throw new ReadError(
      "ENSV2_REVERSE_REGISTRAR_MISMATCH",
      `The chain derives the reverse registrar as ${status.infra.reverseRegistrar}; the deployment table says ${d.reverseRegistrar}.`,
      "Refusing to send a reverse claim to a registrar the table disagrees with. Update the table only after verifying the new contract.",
    );
  }
  const ens = ensClient(client, chainId);
  const forward = await ens.getEnsAddress({ name, universalResolverAddress: d.universalResolver });
  if (!forward || !isAddressEqual(forward, owner)) {
    throw new ReadError(
      "ENSV2_PRIMARY_FORWARD_MISMATCH",
      `${name} resolves to ${forward ?? "nothing"}, not to this wallet (${owner}).`,
      "A primary name must resolve back to the address. Run `ensv2 records set <name>` first (it sets addr to this wallet), then retry.",
    );
  }
  const alreadySet = status.primaryName !== null && status.primaryName === name;
  const calldata = alreadySet
    ? null
    : { to: status.infra.reverseRegistrar, data: encodeFunctionData({ abi: reverseRegistrarAbi, functionName: "setName", args: [name] }), value: 0n };
  return { owner, name, status, alreadySet, calldata };
}
