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
  /**
   * Stable identifier of this pinned deployment, carried through every job,
   * receipt and verification result (common-primitives deploymentId). The
   * program's fixtures and the WS04 live rehearsal both name the Sepolia beta
   * `ensv2-sepolia-2026-07-30`; no deployment manifest has been generated yet
   * (WS01), so this table IS the manifest content and the id is kept in step
   * with the program's usage.
   */
  readonly deploymentId: string;
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
  /** Adapter8004 proxy (unruggable-labs/adapter). Mints on the canonical ERC-8004 registry and binds the agent to a token. */
  readonly adapter8004: `0x${string}`;
  /** Canonical ERC-8004 IdentityRegistry, as reported by adapter8004.identityRegistry(). */
  readonly identityRegistry: `0x${string}`;
  /**
   * The v1 ReverseRegistrar — owner of `addr.reverse` in the v1 registry.
   * Per docs.ens.domains/ensv2/reverse-resolution ("At Launch") the reverse
   * namespace stays on v1 infrastructure: the v2 root binds the `reverse` TLD
   * to ENSV1Resolver, which mirrors the v1 registry, so a primary name is set
   * by calling this contract's setName(name) from the address itself. Derived
   * live on 2026-09-04 two independent ways, both 0xA0a1AbcD…DC0C6:
   * ReverseRegistrarAdapter.REVERSE_REGISTRAR() (deployments/sepolia/
   * ReverseRegistrarAdapter.json) and v1Registry.owner(namehash("addr.reverse")).
   * Re-derived from the v2 root at runtime; a mismatch refuses to send.
   */
  readonly reverseRegistrar: `0x${string}`;
};

export const SEPOLIA: EnsV2Deployment = {
  chainId: SEPOLIA_CHAIN_ID,
  deploymentId: "ensv2-sepolia-2026-07-30",
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
  // Adapter README + live EIP-1967 slot (impl 0x31a68E5b…) + identityRegistry() call, all checked 2026-09-03.
  adapter8004: "0x7621630cB63a73a194f45A3E6801B8C6A7eC2f92",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reverseRegistrar: "0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6",
};

export const DEPLOYMENTS: Readonly<Record<number, EnsV2Deployment>> = {
  [SEPOLIA_CHAIN_ID]: SEPOLIA,
};

export function deploymentForChain(chainId: number): EnsV2Deployment | undefined {
  return DEPLOYMENTS[chainId];
}
