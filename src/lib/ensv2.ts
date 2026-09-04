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
 *
 * TWO GENERATIONS, TWO GATES. `deployment.generation` selects which check list
 * runs, and neither list can pass against the other generation's contracts:
 *
 *   g1 (`beta`)      the five checks above, exactly as in v0.7.2.
 *   g2 (`hackathon`) seven checks: the g2 interface id on the UR, an explicit
 *                    refusal of the g1 interface id on the same contract,
 *                    canonical-registry agreement read from the UniversalHelper
 *                    (the g2 UR reverts on it), the same bidirectional
 *                    root/eth checks, the same factory clone-target check, and
 *                    a liveness probe that the UR's findResolver is callable.
 *
 * The cross-generation refusal is not incidental, it is measured: on
 * 2026-09-04 the beta UR answered supportsInterface(0x1a6cc9f0) == false and
 * the hackathon UR answered supportsInterface(0xf99a5e06) == false, so check 1
 * of each gate rejects the other generation's UR before anything else is read.
 */
import { createPublicClient, http, isAddressEqual, zeroAddress, type Address, type PublicClient } from "viem";
import { registryAbi, universalHelperAbi, universalResolverAbi, verifiableFactoryAbi } from "./abis.js";
import { SEPOLIA, type EnsV2Deployment } from "./deployments.js";

/**
 * IUniversalResolverV2 ERC-165 id on g1 (the `beta` deployment), as probed by
 * ensdomains/ens-cli. FALSE on g2's Universal Resolver (verified live
 * 2026-09-04), which is half of why the two gates cannot cross-accept.
 */
export const UNIVERSAL_RESOLVER_V2_INTERFACE_ID = "0xf99a5e06" as const;

/**
 * IUniversalResolverV2 ERC-165 id on g2 (the `hackathon` deployment).
 * `IUniversalResolverV2` declares exactly one function on that generation —
 * `isENSv2()` — so `type(IUniversalResolverV2).interfaceId` IS that selector,
 * 0x1a6cc9f0, matching the source file's own `@dev Interface selector` note
 * and `toFunctionSelector("isENSv2()")`. Verified live 2026-09-04: true on
 * 0xd26f2040…, false on g1's 0xeEeEEEeE….
 */
export const UNIVERSAL_RESOLVER_V2_G2_INTERFACE_ID = "0x1a6cc9f0" as const;

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
 * The three checks both generations share: root -> eth, eth -> root, and the
 * factory's clone target. Pushes onto `checks` and reports whether all passed.
 */
async function hierarchyAndFactoryChecks(
  client: ReadClient,
  deployment: EnsV2Deployment,
  ethRegistry: Address,
  checks: Check[],
): Promise<{ ok: boolean; proxyLogic: Address }> {
  // Forward pointer: root -> eth.
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
    detail: fwdOk ? undefined : "The configured root registry does not point at the .eth registry this deployment resolves through.",
  });

  // Backward pointer: eth -> root, with the right label.
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

  // Factory sanity: the proxy logic we would predict addresses against is what the factory actually clones.
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

  return { ok: fwdOk && backOk && logicOk, proxyLogic: logic.ok ? logic.value : zeroAddress };
}

/**
 * Detect whether `deployment.universalResolver` is currently serving the
 * ENSv2 generation the table claims, and whether the configured table agrees
 * with the chain. Never throws on a protocol answer; only on a transport
 * failure that prevents any answer.
 *
 * Dispatches on `deployment.generation`; a table of one generation can never
 * be accepted against the other's contracts (see the module header).
 */
export async function detectEnsV2(client: ReadClient, deployment: EnsV2Deployment): Promise<EnsV2Detection> {
  return deployment.generation === "g2" ? detectG2(client, deployment) : detectG1(client, deployment);
}

/** g1 (`beta`): the original five checks, byte-for-byte the v0.7.2 behaviour and output. */
async function detectG1(client: ReadClient, deployment: EnsV2Deployment): Promise<EnsV2Detection> {
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

  // 3, 4, 5. Registry hierarchy in both directions, and the factory's clone target.
  const rest = await hierarchyAndFactoryChecks(client, deployment, ethRegistry, checks);
  if (!rest.ok) return refuse("registry hierarchy or factory does not match the configured deployment");

  return {
    isV2: true,
    chainId: deployment.chainId,
    universalResolver: ur,
    ethRegistry,
    rootRegistry: deployment.rootRegistry,
    proxyLogic: rest.proxyLogic,
    checks,
  };
}

/**
 * g2 (`hackathon`): seven checks. Two things move relative to g1 — the
 * interface id, and where registry navigation lives — so both are checked
 * explicitly, and the g1 interface id is asserted ABSENT so a UR that somehow
 * answered both could still never be mistaken for a g2 deployment.
 */
async function detectG2(client: ReadClient, deployment: EnsV2Deployment): Promise<EnsV2Detection> {
  const checks: Check[] = [];
  const ur = deployment.universalResolver;
  const refuse = (reason: string): EnsV2Detection => ({
    isV2: false,
    chainId: deployment.chainId,
    universalResolver: ur,
    reason,
    checks,
  });

  const helper = deployment.universalHelper;
  if (!helper) {
    checks.push({
      name: "deployment table declares a universalHelper",
      ok: false,
      expected: "an address",
      actual: "undefined",
      detail: "A g2 deployment resolves registry navigation through UniversalHelper; the table is incomplete.",
    });
    return refuse("g2 deployment table has no universalHelper");
  }

  // 1. Is this Universal Resolver the g2 generation right now?
  const supports = await tryRead(() =>
    client.readContract({
      address: ur,
      abi: universalResolverAbi,
      functionName: "supportsInterface",
      args: [UNIVERSAL_RESOLVER_V2_G2_INTERFACE_ID],
    }),
  );
  const supportsV2 = supports.ok && supports.value === true;
  checks.push({
    name: `universalResolver.supportsInterface(IUniversalResolverV2 ${UNIVERSAL_RESOLVER_V2_G2_INTERFACE_ID})`,
    ok: supportsV2,
    expected: "true",
    actual: supports.ok ? String(supports.value) : `revert: ${supports.error}`,
    detail: supportsV2 ? undefined : "The Universal Resolver at this address is not serving the g2 (hackathon) ENSv2 generation.",
  });
  if (!supportsV2) return refuse("Universal Resolver does not support g2 IUniversalResolverV2");

  // 2. And is it NOT the g1 generation? Never cross-accept.
  const g1 = await tryRead(() =>
    client.readContract({
      address: ur,
      abi: universalResolverAbi,
      functionName: "supportsInterface",
      args: [UNIVERSAL_RESOLVER_V2_INTERFACE_ID],
    }),
  );
  const notG1 = g1.ok && g1.value === false;
  checks.push({
    name: `universalResolver.supportsInterface(g1 IUniversalResolverV2 ${UNIVERSAL_RESOLVER_V2_INTERFACE_ID}) == false`,
    ok: notG1,
    expected: "false",
    actual: g1.ok ? String(g1.value) : `revert: ${g1.error}`,
    detail: notG1 ? undefined : "This Universal Resolver also answers the g1 interface id; refusing to treat an ambiguous contract as a g2 deployment.",
  });
  if (!notG1) return refuse("Universal Resolver answers both generations' interface ids");

  // 3. Where does the chain say .eth lives? On g2 that question is answered by
  //    UniversalHelper — the Universal Resolver reverts on it.
  const canon = await tryRead(() =>
    client.readContract({
      address: helper,
      abi: universalHelperAbi,
      functionName: "findCanonicalRegistry",
      args: [ETH_DNS_ENCODED],
    }),
  );
  const ethRegistry = canon.ok ? canon.value : zeroAddress;
  const registryMatches = canon.ok && ethRegistry !== zeroAddress && isAddressEqual(ethRegistry, deployment.registry);
  checks.push({
    name: "universalHelper.findCanonicalRegistry(eth) == configured registry",
    ok: registryMatches,
    expected: deployment.registry,
    actual: canon.ok ? ethRegistry : `revert: ${canon.error}`,
    detail: registryMatches
      ? undefined
      : ethRegistry === zeroAddress
        ? "The UniversalHelper has no canonical .eth registry."
        : "The chain's .eth registry differs from the configured deployment table. Do not transact against a table the chain disagrees with.",
  });
  if (!registryMatches) return refuse("configured .eth registry does not match the UniversalHelper");

  // 4, 5, 6. Registry hierarchy in both directions, and the factory's clone target.
  const rest = await hierarchyAndFactoryChecks(client, deployment, ethRegistry, checks);

  // 7. Resolution liveness: the resolver-location call this plugin reads
  //    through must be callable on the UR itself (it stayed there on g2, while
  //    the registry-navigation calls moved to the helper). A zero resolver for
  //    `eth` is a correct answer — the TLD has none — so only a revert fails.
  const findResolver = await tryRead(() =>
    client.readContract({
      address: ur,
      abi: universalResolverAbi,
      functionName: "findResolver",
      args: [ETH_DNS_ENCODED],
    }),
  );
  checks.push({
    name: "universalResolver.findResolver(eth) is callable",
    ok: findResolver.ok,
    expected: "a (resolver, node, offset) tuple",
    actual: findResolver.ok ? `${findResolver.value.resolver}, offset ${findResolver.value.offset}` : `revert: ${findResolver.error}`,
    detail: findResolver.ok ? undefined : "The Universal Resolver cannot locate resolvers; every read in this plugin goes through it.",
  });

  if (!rest.ok || !findResolver.ok) {
    return refuse("registry hierarchy, factory, or resolver location does not match the configured deployment");
  }

  return {
    isV2: true,
    chainId: deployment.chainId,
    universalResolver: ur,
    ethRegistry,
    rootRegistry: deployment.rootRegistry,
    proxyLogic: rest.proxyLogic,
    checks,
  };
}

/**
 * Standalone runner: `npm run check`. Exercises `detectEnsV2` against a public
 * Sepolia RPC with a plain viem client, so the detection logic can be verified
 * without installing the plugin into `mm`. The `mm ensv2 status` command runs
 * the identical function against the host-provided client.
 */
export async function selfCheck(
  rpcUrl = process.env.ETH_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  deployment: EnsV2Deployment = SEPOLIA,
): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const result = await detectEnsV2(client, deployment);
  process.stdout.write(`deployment ${deployment.key} (${deployment.deploymentId}, generation ${deployment.generation})\n`);
  for (const c of result.checks) {
    process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n`);
    if (!c.ok) process.stdout.write(`      expected ${c.expected}\n      actual   ${c.actual}\n      ${c.detail ?? ""}\n`);
  }
  process.stdout.write(`\n${result.isV2 ? "ENSv2 ACTIVE" : `ENSv2 NOT ACTIVE — ${result.reason}`}  (chain ${result.chainId})\n`);
  if (!result.isV2) process.exitCode = 1;
}
