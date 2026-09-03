/**
 * ENSv2 deployment table.
 *
 * Provenance, in priority order:
 *   0. https://docs.ens.domains/learn/deployments/#sepolia-ensv2-beta — the
 *      official table. Every address below was checked against it on
 *      2026-09-03 and matches. `resolverProxyLogic` is not listed there
 *      because it is the factory's internal clone target; it is read from
 *      `VerifiableFactory.proxyLogic()` and verified live instead.
 *   1. contracts-v2-post-audit-2/contracts/deployments/sepolia/*.json (the
 *      checked-in deployment artifacts — these match the live chain; the
 *      repo's `contracts/src/` does NOT).
 *   2. ensdomains/ens-cli @ 256cc45, src/lib/contracts.ts — an independent
 *      table that agrees byte-for-byte.
 *   3. Live verification on 2026-09-03 via publicnode: the Universal Resolver
 *      reports findCanonicalRegistry("eth") == registry, and the factory
 *      reports proxyLogic() == resolverProxyLogic.
 *
 * These values are NEVER trusted blindly at runtime. `ensv2 status` re-derives
 * the registry from the Universal Resolver and refuses to proceed if the
 * configured value disagrees. That cross-check is the mitigation for hard-coded
 * addresses required by the program's AGENTS.md.
 *
 * Mainnet is deliberately absent. ENSv2 is a Sepolia beta with non-final
 * interfaces; the program invariant is that mainnet stays disabled until a
 * canonical production deployment exists.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

export type EnsV2Deployment = {
  readonly chainId: number;
  /** Public entry point. UpgradableUniversalResolverProxy; same address as mainnet. */
  readonly universalResolver: `0x${string}`;
  /** Root of the registry hierarchy. */
  readonly rootRegistry: `0x${string}`;
  /** The `.eth` PermissionedRegistry — where 2LDs live. */
  readonly registry: `0x${string}`;
  readonly registrar: `0x${string}`;
  readonly rentPriceOracle: `0x${string}`;
  readonly paymentToken: `0x${string}`;
  readonly resolverFactory: `0x${string}`;
  readonly resolverImplementation: `0x${string}`;
  readonly resolverProxyLogic: `0x${string}`;
  readonly subregistryImplementation: `0x${string}`;
};

export const SEPOLIA: EnsV2Deployment = {
  chainId: SEPOLIA_CHAIN_ID,
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  rootRegistry: "0x8115186E8f2E0B0281e86ab91f0f48Ba90364354",
  registry: "0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2",
  registrar: "0xa88553F454b77203B0D036A05c894d555EAAa2Cc",
  rentPriceOracle: "0x8914b66260eb8c4fff795650c3ae8cd335958987",
  paymentToken: "0x768F42455A2D082E23ceeF7d51e5787C82d67a39",
  resolverFactory: "0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef",
  resolverImplementation: "0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e",
  resolverProxyLogic: "0xA136BeE4E37B44586242e516a39893EfD54315e9",
  subregistryImplementation: "0x624a25d67B59D587752EbEc8DdeD8827dAe52050",
};

export const DEPLOYMENTS: Readonly<Record<number, EnsV2Deployment>> = {
  [SEPOLIA_CHAIN_ID]: SEPOLIA,
};

export function deploymentForChain(chainId: number): EnsV2Deployment | undefined {
  return DEPLOYMENTS[chainId];
}
