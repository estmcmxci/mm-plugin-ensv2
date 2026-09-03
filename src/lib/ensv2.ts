/**
 * ENSv2 detection — ported from ensdomains/ens-cli @ 256cc45 (src/lib/context.ts,
 * `isV2Active` + `configuredV2Deployment`), with one deliberate inversion:
 *
 *   ens-cli fails OPEN — a non-v2 answer silently routes the caller to ENSv1.
 *   This module fails CLOSED — a non-v2 answer is a refusal. The program
 *   invariant (AGENTS.md) is "never silently fall back from ENSv2 to ENSv1".
 *
 * Why the probe is `supportsInterface(0xf99a5e06)` and not `isENSv2()`:
 * `isENSv2()` is declared in contracts-v2-post-audit-2/contracts/src/ but does
 * not exist on the deployed Universal Resolver — it reverts (verified live
 * 2026-09-03). The interface probe is what the official CLI uses and returns
 * true on chain.
 *
 * Why five checks and not one: the public Universal Resolver address is an
 * upgradeable proxy that served ENSv1 in an earlier deployment phase. The same
 * address answers as either version depending on what it currently points at.
 * So we (1) ask the UR what it is, (2) ask it where .eth lives, (3) verify the
 * configured table agrees, and (4)(5) verify the registry hierarchy is
 * internally consistent in both directions — the bidirectional check is what
 * the docs prescribe against aliasing.
 */
import { createPublicClient, http, isAddressEqual, zeroAddress, type PublicClient } from "viem";
import { registryAbi, universalResolverAbi, verifiableFactoryAbi } from "./abis.js";
import { SEPOLIA, type EnsV2Deployment } from "./deployments.js";

/** IUniversalResolverV2 ERC-165 id, as probed by ensdomains/ens-cli. */
export const UNIVERSAL_RESOLVER_V2_INTERFACE_ID = "0xf99a5e06" as const;

/** DNS-encoded "eth": length-prefixed label, null terminator. */
export const ETH_DNS_ENCODED = "0x0365746800" as const;

/** Mirrors IPermissionedRegistry.Status. */
export enum V2Status {
  AVAILABLE = 0,
  RESERVED = 1,
  REGISTERED = 2,
}

export type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly expected?: string;
  readonly actual?: string;
  readonly detail?: string;
};

export type EnsV2Detection =
  | {
      readonly isV2: true;
      readonly chainId: number;
      readonly universalResolver: `0x${string}`;
      readonly ethRegistry: `0x${string}`;
      readonly rootRegistry: `0x${string}`;
      readonly proxyLogic: `0x${string}`;
      readonly checks: readonly Check[];
    }
  | {
      readonly isV2: false;
      readonly chainId: number;
      readonly universalResolver: `0x${string}`;
      readonly reason: string;
      readonly checks: readonly Check[];
    };

/** The subset of a viem PublicClient this module needs. Host-provided clients carry no `chain`; that is fine — every call passes an explicit address. */
export type ReadClient = Pick<PublicClient, "readContract">;

async function tryRead<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
}

/**
 * Detect whether `deployment.universalResolver` is currently serving ENSv2 and
 * whether the configured deployment table agrees with the chain. Never throws
 * on a protocol answer; only on a transport failure that prevents any answer.
 */
export async function detectEnsV2(client: ReadClient, deployment: EnsV2Deployment): Promise<EnsV2Detection> {
  const checks: Check[] = [];
  const ur = deployment.universalResolver;
  const refuse = (reason: string): EnsV2Detection => ({
    isV2: false,
    chainId: deployment.chainId,
    universalResolver: ur,
    reason,
    checks,
  });

  // 1. Is the Universal Resolver a v2 resolver right now?
  const supports = await tryRead(() =>
    client.readContract({
      address: ur,
      abi: universalResolverAbi,
      functionName: "supportsInterface",
      args: [UNIVERSAL_RESOLVER_V2_INTERFACE_ID],
    }),
  );
  const supportsV2 = supports.ok && supports.value === true;
  checks.push({
    name: "universalResolver.supportsInterface(IUniversalResolverV2)",
    ok: supportsV2,
    expected: "true",
    actual: supports.ok ? String(supports.value) : `revert: ${supports.error}`,
    detail: supportsV2 ? undefined : "The Universal Resolver at this address is not serving ENSv2.",
  });
  if (!supportsV2) return refuse("Universal Resolver does not support IUniversalResolverV2");

  // 2. Where does the UR say .eth lives, and does our table agree?
  const canon = await tryRead(() =>
    client.readContract({
      address: ur,
      abi: universalResolverAbi,
      functionName: "findCanonicalRegistry",
      args: [ETH_DNS_ENCODED],
    }),
  );
  const ethRegistry = canon.ok ? canon.value : zeroAddress;
  const registryMatches = canon.ok && ethRegistry !== zeroAddress && isAddressEqual(ethRegistry, deployment.registry);
  checks.push({
    name: "universalResolver.findCanonicalRegistry(eth) == configured registry",
    ok: registryMatches,
    expected: deployment.registry,
    actual: canon.ok ? ethRegistry : `revert: ${canon.error}`,
    detail: registryMatches
      ? undefined
      : ethRegistry === zeroAddress
        ? "The Universal Resolver has no canonical .eth registry."
        : "The chain's .eth registry differs from the configured deployment table. Do not transact against a table the chain disagrees with.",
  });
  if (!registryMatches) return refuse("configured .eth registry does not match the Universal Resolver");

  // 3. Forward pointer: root -> eth.
  const fwd = await tryRead(() =>
    client.readContract({
      address: deployment.rootRegistry,
      abi: registryAbi,
      functionName: "getSubregistry",
      args: ["eth"],
    }),
  );
  const fwdOk = fwd.ok && isAddressEqual(fwd.value, ethRegistry);
  checks.push({
    name: "rootRegistry.getSubregistry(eth) == ethRegistry",
    ok: fwdOk,
    expected: ethRegistry,
    actual: fwd.ok ? fwd.value : `revert: ${fwd.error}`,
    detail: fwdOk ? undefined : "The configured root registry does not point at the .eth registry the Universal Resolver uses.",
  });

  // 4. Backward pointer: eth -> root, with the right label.
  const back = await tryRead(() =>
    client.readContract({
      address: ethRegistry,
      abi: registryAbi,
      functionName: "getParent",
    }),
  );
  const backOk = back.ok && isAddressEqual(back.value[0], deployment.rootRegistry) && back.value[1] === "eth";
  checks.push({
    name: "ethRegistry.getParent() == (rootRegistry, eth)",
    ok: backOk,
    expected: `${deployment.rootRegistry}, "eth"`,
    actual: back.ok ? `${back.value[0]}, "${back.value[1]}"` : `revert: ${back.error}`,
    detail: backOk ? undefined : "The .eth registry's parent pointer does not lead back to the configured root. The hierarchy is not canonical.",
  });

  // 5. Factory sanity: the proxy logic we would predict addresses against is what the factory actually clones.
  const logic = await tryRead(() =>
    client.readContract({
      address: deployment.resolverFactory,
      abi: verifiableFactoryAbi,
      functionName: "proxyLogic",
    }),
  );
  const logicOk = logic.ok && isAddressEqual(logic.value, deployment.resolverProxyLogic);
  checks.push({
    name: "resolverFactory.proxyLogic() == configured resolverProxyLogic",
    ok: logicOk,
    expected: deployment.resolverProxyLogic,
    actual: logic.ok ? logic.value : `revert: ${logic.error}`,
    detail: logicOk ? undefined : "CREATE2 resolver address prediction would be wrong against this factory.",
  });

  if (!fwdOk || !backOk || !logicOk) {
    return refuse("registry hierarchy or factory does not match the configured deployment");
  }

  return {
    isV2: true,
    chainId: deployment.chainId,
    universalResolver: ur,
    ethRegistry,
    rootRegistry: deployment.rootRegistry,
    proxyLogic: logic.value,
    checks,
  };
}

/**
 * Standalone runner: `npm run check`. Exercises `detectEnsV2` against a public
 * Sepolia RPC with a plain viem client, so the detection logic can be verified
 * without installing the plugin into `mm`. The `mm ensv2 status` command runs
 * the identical function against the host-provided client.
 */
export async function selfCheck(rpcUrl = process.env.ETH_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const result = await detectEnsV2(client, SEPOLIA);
  for (const c of result.checks) {
    process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n`);
    if (!c.ok) process.stdout.write(`      expected ${c.expected}\n      actual   ${c.actual}\n      ${c.detail ?? ""}\n`);
  }
  process.stdout.write(`\n${result.isV2 ? "ENSv2 ACTIVE" : `ENSv2 NOT ACTIVE — ${result.reason}`}  (chain ${result.chainId})\n`);
  if (!result.isV2) process.exitCode = 1;
}
