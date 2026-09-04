/**
 * ENSv2 deployment table.
 *
 * TWO deployments are pinned, both on Sepolia (chain 11155111), selected by
 * `--deployment <beta|hackathon>` (env `MM_ENSV2_DEPLOYMENT`, default `beta`):
 *
 *   beta       ensv2-sepolia-2026-07-30           generation g1 — the canonical
 *              ENSv2 Sepolia beta. Unchanged from v0.7.2; still the default.
 *   hackathon  ensv2-sepolia-hackathon-2026-09    generation g2 — ENS Labs'
 *              dedicated ETHOnline 2026 deployment, a NEWER contract generation.
 *
 * The two generations are NOT interchangeable, and the gate never cross-accepts
 * one for the other (see ensv2.ts). What actually differs:
 *
 *   | Concern              | g1 (beta)                           | g2 (hackathon)                        |
 *   |----------------------|-------------------------------------|---------------------------------------|
 *   | UR interface id      | 0xf99a5e06                          | 0x1a6cc9f0 (IUniversalResolverV2)     |
 *   | isENSv2()            | reverts                             | returns true                          |
 *   | registry navigation  | on the Universal Resolver           | on a separate UniversalHelper         |
 *   | resolver setters     | setAddr/setText(bytes32 node, …)    | setAddress/setText(bytes DNS name, …) |
 *   | resolver initializer | initialize(address,uint256,bytes[]) | initialize(Grant[],bytes[])           |
 *
 * PROVENANCE
 *
 * beta (g1), each address checked 2026-09-03 and unchanged since:
 *   0. https://docs.ens.domains/learn/deployments/#sepolia-ensv2-beta — the
 *      official table. `resolverProxyLogic` is not listed there because it is
 *      the factory's internal clone target; it is read from
 *      `VerifiableFactory.proxyLogic()` and verified live instead.
 *   1. contracts-v2-post-audit-2/contracts/deployments/sepolia/*.json (the
 *      checked-in deployment artifacts — these match the live chain; that
 *      repo's `contracts/src/` does NOT, it describes g2).
 *   2. ensdomains/ens-cli @ 256cc45, src/lib/contracts.ts — an independent
 *      table that agrees byte-for-byte.
 *   3. Live verification via publicnode: the Universal Resolver reports
 *      findCanonicalRegistry("eth") == registry, and the factory reports
 *      proxyLogic() == resolverProxyLogic.
 *
 * hackathon (g2), every address taken from ONE page and re-derived live on
 * 2026-09-04 (Sepolia archive endpoint sepolia.gateway.tenderly.co):
 *   0. https://feature-permres-inode-refact.docs-bao.pages.dev/learn/deployments#sepolia-ensv2-beta
 *      — "Sepolia (ENSv2 Beta) – ETHOnline 2026 Hackathon Deployment", the
 *      45-row table. That page is the provenance for every literal below; the
 *      addresses are recorded here checksummed, the page lists them lowercase.
 *   1. The matching source tree is contracts-v2-post-audit-2/contracts/src/
 *      (UniversalHelper.sol, PermissionedResolver.sol, ReverseRegistrarAdapter.sol
 *      all exist there and match the deployed contract names) — NOT that repo's
 *      deployments/sepolia artifacts, which describe g1.
 *   2. Live derivations, all reproduced on 2026-09-04:
 *        UpgradableUniversalResolverProxy.implementation() -> 0x1abEd09f… (ManagedUniversalResolverProxy)
 *        UpgradableUniversalResolverProxy.supportsInterface(0x1a6cc9f0) -> true, .isENSv2() -> true
 *        UniversalHelper.findCanonicalRegistry("eth")      -> 0x1D78834d… (= registry)
 *        RootRegistry.getSubregistry("eth")                -> 0x1D78834d…
 *        ETHRegistry.getParent()                           -> (0xe7f0D572…, "eth")
 *        VerifiableFactory.proxyLogic()                    -> 0x2fDCaC2F…
 *        StandardRentPriceOracle.isPaymentToken(MockUSDC)  -> true (USDC, 6 decimals)
 *        ETHRegistrar MIN_REGISTER_DURATION/MIN_COMMITMENT_AGE/MAX_COMMITMENT_AGE -> 2419200 / 60 / 86400
 *        RootRegistry.getResolver("reverse")               -> 0x1F11E5b8… (ENSV1Resolver)
 *        ENSV1Resolver.REGISTRY_V1()                       -> 0x82080Cc8… (hackathon-only v1 registry)
 *        v1Registry.owner(namehash("addr.reverse"))        -> 0x060D5a54…
 *        ReverseRegistrarAdapter.REVERSE_REGISTRAR()       -> 0x060D5a54…  (agrees)
 *      The hackathon contracts were deployed at Sepolia block ~11,626,631.
 *
 * These values are NEVER trusted blindly at runtime. `ensv2 status` re-derives
 * the registry from the deployment's own navigation surface and refuses to
 * proceed if the configured value disagrees. That cross-check is the mitigation
 * for hard-coded addresses required by the program's AGENTS.md.
 *
 * Mainnet is deliberately absent. ENSv2 is a Sepolia beta with non-final
 * interfaces; the program invariant is that mainnet stays disabled until a
 * canonical production deployment exists.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

/**
 * Contract generation. The gate, the registry-navigation surface, the resolver
 * initializer and the record setters are all chosen by this discriminator, and
 * a table of one generation must never be accepted against the other's
 * contracts.
 */
export type EnsV2Generation = "g1" | "g2";

/** Selector accepted by `--deployment` and `MM_ENSV2_DEPLOYMENT`. */
export type DeploymentKey = "beta" | "hackathon";

export type EnsV2Deployment = {
  /** The `--deployment` selector. */
  readonly key: DeploymentKey;
  readonly chainId: number;
  /**
   * Stable identifier of this pinned deployment, carried through every job,
   * receipt and verification result (common-primitives deploymentId), and
   * mixed into the intent's EIP-712 salt, so two deployments never share a
   * job id.
   */
  readonly deploymentId: string;
  /** Which contract generation this table describes. */
  readonly generation: EnsV2Generation;
  /** Public entry point. UpgradableUniversalResolverProxy. */
  readonly universalResolver: `0x${string}`;
  /**
   * g2 only: registry navigation (findCanonicalRegistry / findParentRegistry /
   * findExactRegistry) moved off the Universal Resolver onto this contract.
   * Undefined on g1, where the UR answers those itself.
   */
  readonly universalHelper?: `0x${string}`;
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
  /** Adapter8004 proxy (unruggable-labs/adapter). Mints on the canonical ERC-8004 registry and binds the agent to a token. Deployment-independent. */
  readonly adapter8004: `0x${string}`;
  /** Canonical ERC-8004 IdentityRegistry, as reported by adapter8004.identityRegistry(). Deployment-independent. */
  readonly identityRegistry: `0x${string}`;
  /**
   * The v1 ReverseRegistrar — owner of `addr.reverse` in the v1 registry this
   * deployment's `reverse` TLD mirrors. Per
   * docs.ens.domains/ensv2/reverse-resolution ("At Launch") the reverse
   * namespace stays on v1 infrastructure: the v2 root binds the `reverse` TLD
   * to ENSV1Resolver, which mirrors a v1 registry, so a primary name is set by
   * calling this contract's setName(name) from the address itself.
   *
   * Each deployment mirrors a DIFFERENT v1 registry and therefore has its own
   * reverse registrar. Re-derived from the v2 root at runtime (primary.ts); a
   * mismatch refuses to send.
   */
  readonly reverseRegistrar: `0x${string}`;
};

/**
 * The canonical ENSv2 Sepolia beta — generation g1, and the default. Unchanged
 * from v0.7.2 in every address; `key` and `generation` are new metadata only.
 */
export const SEPOLIA: EnsV2Deployment = {
  key: "beta",
  chainId: SEPOLIA_CHAIN_ID,
  deploymentId: "ensv2-sepolia-2026-07-30",
  generation: "g1",
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
  // ReverseRegistrarAdapter.REVERSE_REGISTRAR() and v1Registry.owner(namehash("addr.reverse")), both 2026-09-04.
  reverseRegistrar: "0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6",
};

/**
 * ENS Labs' dedicated ETHOnline 2026 hackathon deployment — generation g2.
 * Every address below is a row of the deployments page named in the file
 * header, checksummed; the derivations listed there were reproduced live on
 * 2026-09-04. Separate namespace from the beta: a name registered on one does
 * not exist on the other, and neither do the agents bound to it.
 */
export const SEPOLIA_HACKATHON: EnsV2Deployment = {
  key: "hackathon",
  chainId: SEPOLIA_CHAIN_ID,
  deploymentId: "ensv2-sepolia-hackathon-2026-09",
  generation: "g2",
  // page row "UpgradableUniversalResolverProxy" — the address the docs tell you to
  // override viem's `ensUniversalResolver` with. implementation() -> 0x1abEd09f…
  // (page row "ManagedUniversalResolverProxy"), which fronts UniversalResolverV2
  // 0xfeA8D4b7… (page row "UniversalResolverV2"). Not an EIP-1967 proxy.
  universalResolver: "0xd26f2040D083Af1cD2962ba303F4BEa0c4faf142",
  // page row "UniversalHelper" — findCanonicalRegistry / findParentRegistry /
  // findExactRegistry live here on g2; the UR itself reverts on them.
  universalHelper: "0x1d4cd7545d456f3b6A7E4380182279AFcFa887b6",
  rootRegistry: "0xe7f0D5724f8337e3Aa9A9910540341Ff4273fEd9", // page row "RootRegistry"
  registry: "0x1D78834d97c1D7b1A38c1deDBD1a287cFEd3971e", // page row "ETHRegistry"
  registrar: "0x7d1B7f586a62Ac3F54b9A396849757814283270b", // page row "ETHRegistrar"
  rentPriceOracle: "0xFeba6589b5C1B35875C0389CCEDF83148B6eE71B", // page row "StandardRentPriceOracle"
  paymentToken: "0xcBFD80F74375c54E545AF34788Ff465F96F66F05", // page row "MockUSDC" — USDC, 6 decimals, the oracle accepts it
  resolverFactory: "0x894bc9cC8ff1ad96B8a288C86A8C71D662C07780", // page row "VerifiableFactory"
  resolverImplementation: "0xa9d3814AB151BF6E37A427432795371a8361614e", // page row "PermissionedResolverImpl"
  // Not on the page: the factory's internal ERC-1167 clone target, read live
  // from VerifiableFactory.proxyLogic() and re-verified by the gate on use.
  resolverProxyLogic: "0x2fDCaC2F94B2E65c5d5fBf36EC34483d25Ca9025",
  subregistryImplementation: "0x47B442d0CF617c41CAbAFf5f02f44DD1e5f72546", // page row "UserRegistryImpl"
  // Deployment-independent: the adapter and the canonical ERC-8004 registry are
  // the same contracts for both deployments (adapter.identityRegistry() and the
  // EIP-1967 slot re-checked against them on 2026-09-04).
  adapter8004: "0x7621630cB63a73a194f45A3E6801B8C6A7eC2f92",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  // NOT the beta's 0xA0a1AbcD…: this deployment's `reverse` TLD resolver is
  // ENSV1Resolver 0x1F11E5b8… (page row), whose REGISTRY_V1() is the
  // hackathon-only v1 registry 0x82080Cc8…, whose owner(namehash("addr.reverse"))
  // is the address below — which equals ReverseRegistrarAdapter.REVERSE_REGISTRAR()
  // (page row "ReverseRegistrarAdapter" 0x67Ee6806…). Both derivations agree.
  reverseRegistrar: "0x060D5a54a8751eEc63B756E32Ef66f5eEf418e60",
};

/** The deployment used when neither `--deployment` nor `MM_ENSV2_DEPLOYMENT` says otherwise. */
export const DEFAULT_DEPLOYMENT_KEY: DeploymentKey = "beta";

/** Every pinned deployment, keyed by its `--deployment` selector. */
export const DEPLOYMENTS: Readonly<Record<DeploymentKey, EnsV2Deployment>> = {
  beta: SEPOLIA,
  hackathon: SEPOLIA_HACKATHON,
};

export const DEPLOYMENT_KEYS = Object.keys(DEPLOYMENTS) as readonly DeploymentKey[];

export function isDeploymentKey(v: string): v is DeploymentKey {
  return Object.prototype.hasOwnProperty.call(DEPLOYMENTS, v);
}

/** The deployment for `key`, or undefined. Chain-agnostic; the caller checks the chain. */
export function deploymentByKey(key: string): EnsV2Deployment | undefined {
  return isDeploymentKey(key) ? DEPLOYMENTS[key] : undefined;
}

/**
 * The deployment for (chainId, key). Returns undefined when the chain is not
 * supported, or when the named deployment does not live on that chain.
 */
export function deploymentFor(chainId: number, key: DeploymentKey = DEFAULT_DEPLOYMENT_KEY): EnsV2Deployment | undefined {
  const d = deploymentByKey(key);
  return d && d.chainId === chainId ? d : undefined;
}

/** Back-compat: the default deployment for a chain. Prefer `deploymentFor(chainId, key)`. */
export function deploymentForChain(chainId: number): EnsV2Deployment | undefined {
  return deploymentFor(chainId, DEFAULT_DEPLOYMENT_KEY);
}

/** Deployments on a chain, in table order. */
export function deploymentsOnChain(chainId: number): EnsV2Deployment[] {
  return DEPLOYMENT_KEYS.map((k) => DEPLOYMENTS[k]).filter((d) => d.chainId === chainId);
}

/** The pinned deployment carrying this `deploymentId`, if any. Used to name the table a job belongs to. */
export function deploymentByDeploymentId(deploymentId: string): EnsV2Deployment | undefined {
  return DEPLOYMENT_KEYS.map((k) => DEPLOYMENTS[k]).find((d) => d.deploymentId === deploymentId);
}
