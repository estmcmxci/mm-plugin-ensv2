/**
 * ENSv2 deployment table.
 *
 * FOUR deployments are pinned, selected by `--deployment
 * <sepolia|mainnet|hackathon|beta>` (env `MM_ENSV2_DEPLOYMENT`, default
 * `sepolia`). Two are live and canonical, one is a live side deployment, one
 * is dead and kept only so old jobs still resolve:
 *
 *   sepolia    ensv2-sepolia-2026-10-01       generation g3, chain 11155111.
 *              ENS Labs' canonical ENSv2 testnet deployment and THE DEFAULT.
 *              The "Sepolia (ENSv2)" table on docs.ens.domains/learn/deployments.
 *   mainnet    ensv2-mainnet-2026-10-18       generation g3, chain 1.
 *              ENSv2 on Ethereum mainnet. Live and serving: `isENSv2()` is
 *              true, migrated names answer from the v2 `.eth` registry,
 *              unmigrated ones fall through to ENSV1Resolver, and registration
 *              is priced in REAL USDC and DAI. Namechain was cancelled in
 *              February 2026 and ENSv2 shipped on L1 instead, which is why
 *              there is a mainnet table at all — see "MAINNET" below.
 *   hackathon  ensv2-sepolia-hackathon-2026-09 generation g2, chain 11155111.
 *              ENS Labs' dedicated ETHOnline 2026 deployment. Still live and
 *              still passes its gate (re-verified 2026-10-27), but superseded:
 *              it is a side deployment, not a line ENS Labs carries forward.
 *   beta       ensv2-sepolia-2026-07-30       generation g1, chain 11155111.
 *              DEAD. The address it calls `universalResolver`
 *              (0xeEeEEEeE…EeEe) is a proxy that ENS Labs has since upgraded
 *              twice; it now serves `sepolia` (g3) above. The rest of this
 *              table's addresses are orphaned contracts no canonical surface
 *              points at any more. Kept pinned, never deleted, so jobs and
 *              receipts written against it still resolve their deploymentId —
 *              and the g1 gate keeps refusing it, which is correct.
 *
 * The generations are NOT interchangeable and the gate never cross-accepts one
 * for another (see ensv2.ts). What actually differs:
 *
 *   | Concern              | g1 (beta)                           | g2 (hackathon)                        | g3 (sepolia, mainnet)                 |
 *   |----------------------|-------------------------------------|---------------------------------------|---------------------------------------|
 *   | UR version probe     | supportsInterface(0xf99a5e06)       | supportsInterface(0x1a6cc9f0)         | isENSv2() == true; BOTH ids false     |
 *   | isENSv2()            | reverts                             | returns true                          | returns true                          |
 *   | registry navigation  | on the Universal Resolver           | on a separate UniversalHelper         | on a separate UniversalHelper         |
 *   | resolver setters     | setAddr/setText(bytes32 node, …)    | setAddress/setText(bytes DNS name, …) | same as g2                            |
 *   | resolver initializer | initialize(address,uint256,bytes[]) | initialize(Grant[],bytes[])           | same as g2                            |
 *
 * g3 IS g2's contracts. The ETHOnline deployment and the launch deployment
 * were built from the same sources, and on 2026-10-27 the deployed bytecode
 * was compared selector by selector to prove it: ETHRegistrar is the same
 * 8037 bytes with the same eight entry points on all three of hackathon,
 * sepolia and mainnet; PermissionedResolverImpl exposes exactly
 * setAddress(bytes,uint256,bytes) 0xb4436dde, setText(bytes,string,string)
 * 0xc7279f88, multicall(bytes[]) 0xac9650d8, resolve(bytes,bytes) and
 * initialize((address,uint256)[],bytes[]) 0x33cc44a0 on all three, with g1's
 * setAddr(bytes32,address) / setText(bytes32,string,string) /
 * initialize(address,uint256,bytes[]) absent from all three; VerifiableFactory
 * is the same 1524 bytes and ETHRegistry the same 16000.
 *
 * So g3 is a separate generation for ONE reason: its Universal Resolver no
 * longer advertises the g2 ERC-165 interface id. That is the gate's business,
 * not the encoders' — which is why `contractSurface()` below maps g2 and g3
 * onto the same calldata and only `detectEnsV2` splits them. Upstream made the
 * same move: ensdomains/ens-cli now gates on `isENSv2()` rather than on an
 * interface id.
 *
 * PROVENANCE
 *
 * sepolia (g3) and mainnet (g3), every address taken from ONE page per
 * network and every derivable value re-derived live on 2026-10-27:
 *   0. https://docs.ens.domains/learn/deployments — the "Sepolia (ENSv2)" and
 *      "Mainnet (ENSv2)" tables. Those pages are the provenance for every
 *      literal below; addresses are recorded here checksummed, the pages list
 *      them lowercase.
 *   1. A second, independent table agrees on every address pinned here:
 *      ensdomains/ensjs @ main, packages/ensjs/src/clients/chain.ts (registry,
 *      registrar, factory, resolver impl, user-registry impl, rent oracle,
 *      payment token, universal helper, universal resolver — mainnet and
 *      Sepolia both). Where ensjs and ens-cli disagree with each other, this
 *      table follows docs + ensjs, the two that agree: ens-cli @ main records
 *      a different mainnet `subregistryImplementation` (0x75FF9AdB…) and a
 *      different `lockedMigrationController`. `subregistryImplementation` is
 *      carried for completeness and read by nothing in this plugin, so that
 *      disagreement cannot change behaviour; the migration controllers are not
 *      pinned at all.
 *   2. Live derivations, all reproduced 2026-10-27 (Sepolia block 12006528 via
 *      ethereum-sepolia-rpc.publicnode.com, mainnet block 26285436 via
 *      ethereum-rpc.publicnode.com):
 *
 *        sepolia                                            mainnet
 *        UpgradableUniversalResolverProxy.isENSv2()      -> true                  | true
 *        …     .supportsInterface(0x01ffc9a7)            -> true                  | true
 *        …     .supportsInterface(0xf99a5e06)  [g1]      -> false                 | false
 *        …     .supportsInterface(0x1a6cc9f0)  [g2]      -> false                 | false
 *        …     .implementation()                         -> 0x6d80F217…           | 0xcFFd2Ae6…  (ManagedUniversalResolverProxy)
 *        …     .findCanonicalRegistry("eth")             -> REVERTS               | REVERTS      (navigation is on the helper, as on g2)
 *        …     .findResolver("eth")                      -> callable              | callable
 *        UniversalHelper.findCanonicalRegistry("eth")    -> 0xD4eBcbBd… = registry| 0xf60aba43… = registry
 *        UniversalHelper.findParentRegistry("eth")       -> 0xB458D6a3… = root    | 0x2553c09b… = root
 *        RootRegistry.getSubregistry("eth")              -> 0xD4eBcbBd…           | 0xf60aba43…
 *        ETHRegistry.getParent()                         -> (0xB458D6a3…, "eth")  | (0x2553c09b…, "eth")
 *        VerifiableFactory.proxyLogic()                  -> 0xC41576B4…           | 0x8E77da0d…
 *        StandardRentPriceOracle.isPaymentToken(token)   -> true                  | true
 *        paymentToken.symbol()/.decimals()               -> USDC / 6              | USDC / 6
 *        ETHRegistrar MIN_REGISTER_DURATION/MIN_/MAX_COMMITMENT_AGE
 *                                                        -> 2419200 / 60 / 86400  | 2419200 / 60 / 86400
 *        ETHRegistrar.BENEFICIARY()                      -> 0x84D3a426…           | 0x4F2083f5…
 *        RootRegistry.getResolver("reverse")             -> 0x322B7581…           | 0x394D8EB4…  (ENSV1Resolver)
 *        ENSV1Resolver.REGISTRY_V1()                     -> 0x0000…2e1e           | 0x0000…2e1e  (the canonical v1 registry, both)
 *        ReverseRegistrarAdapter.REVERSE_REGISTRAR()     -> 0xA0a1AbcD…           | 0xa58E81fe…
 *        v1Registry.owner(namehash("addr.reverse"))      -> 0xA0a1AbcD…           | 0xa58E81fe…  (agrees, both)
 *        Adapter8004.identityRegistry()                  -> 0x8004A818…           | NO CODE AT THE ADAPTER ADDRESS
 *
 *      Note the last line: both reverse-registrar derivations agree on each
 *      network, and both networks' `reverse` TLD mirrors the SAME canonical v1
 *      registry — unlike `hackathon`, which mirrors a hackathon-only one.
 *
 * beta (g1): addresses unchanged from v0.7.2, each checked 2026-09-03 against
 *   the then-official deployments table, contracts-v2-post-audit-2's Sepolia
 *   artifacts, and ensdomains/ens-cli @ 256cc45, which agreed byte-for-byte.
 *   All three sources have since moved on. Kept verbatim as the historical
 *   record a 0.7.x job was written against.
 *
 * hackathon (g2): every address from the ETHOnline deployments page named in
 *   v0.8.0's header, re-derived live 2026-09-04 and re-verified 2026-10-27
 *   (all seven gate checks still pass).
 *
 * These values are NEVER trusted blindly at runtime. `ensv2 status` re-derives
 * the registry from the deployment's own navigation surface and refuses to
 * proceed if the configured value disagrees. That cross-check is the
 * mitigation for hard-coded addresses required by the program's AGENTS.md.
 *
 * MAINNET
 *
 * Mainnet is pinned, and that is a reversal. Every version of this file up to
 * v0.8.1 said "Mainnet is deliberately absent. ENSv2 is a Sepolia beta with
 * non-final interfaces; the program invariant is that mainnet stays disabled
 * until a canonical production deployment exists." That condition has been
 * met: ENS Labs cancelled Namechain in February 2026, deployed ENSv2 to
 * Ethereum L1 instead, and the mainnet Universal Resolver now answers
 * `isENSv2()` with true. The invariant did not change; its precondition did.
 *
 * Two mainnet facts are load-bearing and deliberately NOT smoothed over:
 *
 *   1. Registration costs real money. `StandardRentPriceOracle` accepts real
 *      USDC (0xA0b86991…) and real DAI (0x6B175474…); a free 15-character
 *      label quoted 8000021 base units — $8.000021 for a year — on
 *      2026-10-27. Nothing here is a faucet token, which is also why
 *      `ensv2 faucet` stays Sepolia-only: mainnet USDC has no open `mint`.
 *   2. An agent cannot be bound on mainnet. `Adapter8004` (0x7621630c…) has
 *      NO CODE on chain 1, so this table omits `adapter8004` and every command
 *      that mints, binds, inspects or repoints an agent refuses by name rather
 *      than guessing an address. When unruggable-labs ships it, that is a
 *      one-line table edit and no code change. The canonical ERC-8004
 *      IdentityRegistry is a separate question and IS pinned: it is live on
 *      mainnet at the same address and behind the same implementation as on
 *      Sepolia, so ENSIP-25 agent records still derive and read on chain 1.
 */

export const MAINNET_CHAIN_ID = 1;
export const SEPOLIA_CHAIN_ID = 11155111;

/**
 * Contract generation. The gate, the registry-navigation surface, the resolver
 * initializer and the record setters are all chosen by this discriminator, and
 * a table of one generation must never be accepted against another's
 * contracts.
 *
 * g2 and g3 share their contracts and differ only in what the Universal
 * Resolver advertises (see the file header); `contractSurface()` is how
 * everything but the gate collapses that distinction.
 */
export type EnsV2Generation = "g1" | "g2" | "g3";

/** Selector accepted by `--deployment` and `MM_ENSV2_DEPLOYMENT`. */
export type DeploymentKey = "sepolia" | "mainnet" | "hackathon" | "beta";

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
   * g2/g3: registry navigation (findCanonicalRegistry / findParentRegistry /
   * findExactRegistry) lives off the Universal Resolver, on this contract.
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
  /**
   * Adapter8004 proxy (unruggable-labs/adapter). Mints on the canonical
   * ERC-8004 registry and binds the agent to a token.
   *
   * ABSENT where the adapter is not deployed — mainnet, as of 2026-10-27.
   * Without it an agent cannot be minted, bound, inspected through the adapter
   * or repointed, and the commands that do those things refuse by name
   * (`hasAgentIdentity`) rather than guessing an address.
   */
  readonly adapter8004?: `0x${string}`;
  /**
   * Canonical ERC-8004 IdentityRegistry, as reported by
   * adapter8004.identityRegistry() where there is an adapter.
   *
   * Independent of `adapter8004`: mainnet has this registry but no adapter, so
   * ENSIP-25 keys still derive and still read there while binding refuses. A
   * deployment with an adapter always has the registry too.
   */
  readonly identityRegistry?: `0x${string}`;
  /**
   * The v1 ReverseRegistrar — owner of `addr.reverse` in the v1 registry this
   * deployment's `reverse` TLD mirrors. Per
   * docs.ens.domains/ensv2/reverse-resolution ("At Launch") the reverse
   * namespace stays on v1 infrastructure: the v2 root binds the `reverse` TLD
   * to ENSV1Resolver, which mirrors a v1 registry, so a primary name is set by
   * calling this contract's setName(name) from the address itself. That is
   * still true at mainnet launch.
   *
   * Each deployment mirrors a DIFFERENT v1 registry and therefore has its own
   * reverse registrar. Re-derived from the v2 root at runtime (primary.ts); a
   * mismatch refuses to send.
   */
  readonly reverseRegistrar: `0x${string}`;
};

/** A deployment that can bind ERC-8004 agent identity: both adapter and registry present. */
export type EnsV2DeploymentWithIdentity = EnsV2Deployment & {
  readonly adapter8004: `0x${string}`;
  readonly identityRegistry: `0x${string}`;
};

/**
 * ENS Labs' canonical ENSv2 Sepolia deployment — generation g3, and the
 * DEFAULT. The "Sepolia (ENSv2)" table on docs.ens.domains, agreed by ensjs,
 * and re-derived live on 2026-10-27 (see the file header). This replaced the
 * `beta` table: the two share the `universalResolver` ADDRESS, because that
 * address is a proxy and ENS Labs upgraded it in place — which is exactly why
 * the gate asks the chain what it is serving rather than trusting the address.
 */
export const SEPOLIA_ENSV2: EnsV2Deployment = {
  key: "sepolia",
  chainId: SEPOLIA_CHAIN_ID,
  deploymentId: "ensv2-sepolia-2026-10-01",
  generation: "g3",
  // page row "UpgradableUniversalResolverProxy" — the same vanity address the
  // v1 Universal Resolver used, now upgraded through to v2.
  // implementation() -> 0x6d80F217… (page row "ManagedUniversalResolverProxy"),
  // which fronts UniversalResolverV2 0x24e1d8e0… (page row).
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  // page row "UniversalHelper" — findCanonicalRegistry / findParentRegistry /
  // findExactRegistry live here; the UR itself reverts on them.
  universalHelper: "0xd453e5Bdb62CC3beA84341B1e306319C8Ffd7DFe",
  rootRegistry: "0xB458D6a3a77919449d03e7A6903C26827c1eC43f", // page row "RootRegistry"
  registry: "0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4", // page row "ETHRegistry"
  registrar: "0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3", // page row "ETHRegistrar"
  rentPriceOracle: "0x8196665D4ca7488B6474a9EC8E7d2719FB42263A", // page row "StandardRentPriceOracle"
  paymentToken: "0x240b0316Df57887DBBE58b586508b19e633a14aa", // page row "MockUSDC" — symbol USDC, 6 decimals, the oracle accepts it
  resolverFactory: "0xDa70306C98E97eCe36F997a21368e53298572991", // page row "VerifiableFactory"
  resolverImplementation: "0x115eb53F0c60696633855F90b138178Fb40b2b2C", // page row "PermissionedResolverImpl"
  // Not on the page: the factory's internal ERC-1167 clone target, read live
  // from VerifiableFactory.proxyLogic() and re-verified by the gate on use.
  resolverProxyLogic: "0xC41576B4B809B99CF0fF2e5B41b4F147cd9b6BDd",
  subregistryImplementation: "0x9BD8a88719068D09ecee662f36C0E3856708366a", // page row "UserRegistryImpl"
  // Adapter8004 and the canonical ERC-8004 registry, re-checked 2026-10-27:
  // the adapter still has code on Sepolia and still reports this registry.
  adapter8004: "0x7621630cB63a73a194f45A3E6801B8C6A7eC2f92",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  // Two independent derivations agree (2026-10-27): the root's `reverse`
  // resolver is ENSV1Resolver 0x322B7581… (page row), whose REGISTRY_V1() is
  // the CANONICAL v1 Sepolia registry 0x0000…2e1e, whose
  // owner(namehash("addr.reverse")) is the address below — which equals
  // ReverseRegistrarAdapter.REVERSE_REGISTRAR() (page row 0x56bce5e7…).
  reverseRegistrar: "0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6",
};

/**
 * ENSv2 on Ethereum mainnet — generation g3, chain 1. Live and serving as of
 * 2026-10-27: `isENSv2()` is true, the registry hierarchy is internally
 * consistent in both directions, migrated names answer from the v2 `.eth`
 * registry (nick.eth reads REGISTERED there with its own resolver) and
 * unmigrated ones fall through to ENSV1Resolver (vitalik.eth, ens.eth read
 * RESERVED).
 *
 * Registration here spends REAL USDC or DAI, and there is no ERC-8004 adapter
 * on this chain — see "MAINNET" in the file header for both.
 */
export const MAINNET_ENSV2: EnsV2Deployment = {
  key: "mainnet",
  chainId: MAINNET_CHAIN_ID,
  deploymentId: "ensv2-mainnet-2026-10-18",
  generation: "g3",
  // page row "UpgradableUniversalResolverProxy" — the same address that served
  // the v1 Universal Resolver on mainnet, upgraded in place at launch.
  // implementation() -> 0xcFFd2Ae6… (page row "ManagedUniversalResolverProxy"),
  // fronting UniversalResolverV2 0x06fdd07f… (page row).
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  universalHelper: "0x46AE127D14683Ac74eF151e46ae2117A1A25C676", // page row "UniversalHelper"
  rootRegistry: "0x2553c09bE6447BeFfdB86FA622ad41fB8f77A91e", // page row "RootRegistry"
  registry: "0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2", // page row "ETHRegistry"
  registrar: "0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81", // page row "ETHRegistrar"
  rentPriceOracle: "0x76F29609A363a8A1a2a6abe2e859C0F8916Af469", // page row "StandardRentPriceOracle"
  // REAL USDC — 6 decimals, confirmed symbol/decimals on chain. The oracle
  // also accepts real DAI (0x6B175474…); this is the token the plugin quotes
  // and approves in, as on every other deployment.
  paymentToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  resolverFactory: "0x77510ba162dfeA3d8989E3f0928a691B345730D2", // page row "VerifiableFactory"
  resolverImplementation: "0x565b0F456a04Ac9b48758190e90030623Cff57C5", // page row "PermissionedResolverImpl"
  // VerifiableFactory.proxyLogic(), read live; not on the page.
  resolverProxyLogic: "0x8E77da0dAb32EfCc1C75e0Bd0e17680EBe0b1414",
  // page row "UserRegistryImpl"; ensjs agrees, ens-cli records 0x75FF9AdB…
  // instead. Read by nothing here — see PROVENANCE note 1.
  subregistryImplementation: "0xFAA23592ACA10A6d8875b18eA86954e8EB6d8d72",
  // adapter8004 deliberately ABSENT: Adapter8004 has no code on chain 1
  // (checked 2026-10-27), so nothing can be MINTED or BOUND here and every
  // command that would try refuses by name. The canonical ERC-8004 registry
  // below is a different matter — it is fully live on mainnet (same
  // implementation 0x7274e874… as on Sepolia, agent #1 owned by
  // 0xc67fAB15… with an ipfs:// tokenURI, read 2026-10-27), so ENSIP-25
  // record keys still derive and still read correctly here.
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  // Two independent derivations agree (2026-10-27): the root's `reverse`
  // resolver is ENSV1Resolver 0x394D8EB4… (page row), whose REGISTRY_V1() is
  // the canonical v1 registry 0x0000…2e1e, whose
  // owner(namehash("addr.reverse")) is the address below — which equals
  // ReverseRegistrarAdapter.REVERSE_REGISTRAR() (page row 0x34915173…). It is
  // the L1 Reverse Registrar of the mainnet ENSv1 table.
  reverseRegistrar: "0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb",
};

/**
 * ENS Labs' dedicated ETHOnline 2026 hackathon deployment — generation g2.
 * Still live: all seven of its gate checks passed again on 2026-10-27. It is
 * no longer the default, and it is not a line ENS Labs carries forward — it is
 * a side deployment that the canonical `sepolia` table above superseded.
 * Separate namespace from every other table: a name registered here does not
 * exist elsewhere, and neither do the agents bound to it.
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
  // The same adapter and canonical ERC-8004 registry as the Sepolia tables
  // (adapter.identityRegistry() and the EIP-1967 slot re-checked 2026-09-04).
  adapter8004: "0x7621630cB63a73a194f45A3E6801B8C6A7eC2f92",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  // NOT 0xA0a1AbcD…: this deployment's `reverse` TLD resolver is ENSV1Resolver
  // 0x1F11E5b8… (page row), whose REGISTRY_V1() is the hackathon-only v1
  // registry 0x82080Cc8…, whose owner(namehash("addr.reverse")) is the address
  // below — which equals ReverseRegistrarAdapter.REVERSE_REGISTRAR() (page row
  // "ReverseRegistrarAdapter" 0x67Ee6806…). Both derivations agree.
  reverseRegistrar: "0x060D5a54a8751eEc63B756E32Ef66f5eEf418e60",
};

/**
 * The g1 generation of the original ENSv2 Sepolia beta — DEAD. ENS Labs
 * upgraded the proxy at `universalResolver` out from under this table (first
 * on 2026-09-15, again at launch); that address now serves `sepolia` (g3), and
 * the rest of these addresses are orphaned. The g1 gate refuses it, which is
 * the correct outcome, not a bug to fix.
 *
 * Kept pinned, addresses unchanged from v0.7.2, so that a job, receipt or
 * verification result written against `ensv2-sepolia-2026-07-30` still
 * resolves the table it was made under.
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
 * The deployment used when neither `--deployment` nor `MM_ENSV2_DEPLOYMENT`
 * says otherwise, and no `--chain` implies another one.
 *
 * `sepolia` since 2026-10-27 — ENS Labs' canonical ENSv2 testnet deployment.
 * The default has moved twice before: `beta` from launch through v0.8.0, then
 * `hackathon` in v0.8.1 when `beta`'s table went stale. This time the default
 * IS the canonical line rather than the last table left standing. A testnet
 * stays the default deliberately: mainnet is pinned and fully supported, but
 * spending real USDC is something you ask for with `--deployment mainnet` (or
 * `--chain 1`), never something you get by omission.
 */
export const DEFAULT_DEPLOYMENT_KEY: DeploymentKey = "sepolia";

/** Every pinned deployment, keyed by its `--deployment` selector. */
export const DEPLOYMENTS: Readonly<Record<DeploymentKey, EnsV2Deployment>> = {
  sepolia: SEPOLIA_ENSV2,
  mainnet: MAINNET_ENSV2,
  hackathon: SEPOLIA_HACKATHON,
  beta: SEPOLIA,
};

export const DEPLOYMENT_KEYS = Object.keys(DEPLOYMENTS) as readonly DeploymentKey[];

/**
 * Which deployment a bare `--chain <id>` means. One canonical table per chain;
 * the others on that chain have to be named. Omitting both flags gives
 * `DEFAULT_DEPLOYMENT_KEY`, which is this map's Sepolia entry.
 */
export const DEFAULT_DEPLOYMENT_FOR_CHAIN: Readonly<Record<number, DeploymentKey>> = {
  [SEPOLIA_CHAIN_ID]: "sepolia",
  [MAINNET_CHAIN_ID]: "mainnet",
};

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

/** The canonical deployment of a chain, if the plugin pins one. */
export function defaultDeploymentForChain(chainId: number): EnsV2Deployment | undefined {
  const key = DEFAULT_DEPLOYMENT_FOR_CHAIN[chainId];
  return key ? DEPLOYMENTS[key] : undefined;
}

/** Back-compat: the canonical deployment for a chain. Prefer `deploymentFor(chainId, key)`. */
export function deploymentForChain(chainId: number): EnsV2Deployment | undefined {
  return defaultDeploymentForChain(chainId);
}

/** Deployments on a chain, in table order. */
export function deploymentsOnChain(chainId: number): EnsV2Deployment[] {
  return DEPLOYMENT_KEYS.map((k) => DEPLOYMENTS[k]).filter((d) => d.chainId === chainId);
}

/** The pinned deployment carrying this `deploymentId`, if any. Used to name the table a job belongs to. */
export function deploymentByDeploymentId(deploymentId: string): EnsV2Deployment | undefined {
  return DEPLOYMENT_KEYS.map((k) => DEPLOYMENTS[k]).find((d) => d.deploymentId === deploymentId);
}

/**
 * Which contract surface this deployment's calldata must target.
 *
 * g2 and g3 are the same contracts — proven selector by selector against the
 * deployed bytecode of all three g2/g3 deployments on 2026-10-27 (see the file
 * header) — so every encoder treats them alike and only `detectEnsV2` tells
 * them apart. g1 is the odd one out: namehash-keyed setters and a different
 * resolver initializer.
 */
export function contractSurface(d: EnsV2Deployment): "g1" | "g2" {
  return d.generation === "g1" ? "g1" : "g2";
}

/**
 * Whether this deployment can bind ERC-8004 agent identity at all — that is,
 * whether it has the Adapter8004 that mints and binds. False on mainnet, where
 * the adapter is not deployed (checked 2026-10-27) even though the canonical
 * ERC-8004 registry is. Callers that mint, bind, inspect or repoint an agent
 * narrow with this and refuse by name rather than reading from a guessed or
 * zero address; callers that only need ENSIP-25 keys want `identityRegistry`,
 * which mainnet has.
 */
export function hasAgentIdentity(d: EnsV2Deployment): d is EnsV2DeploymentWithIdentity {
  return typeof d.adapter8004 === "string" && typeof d.identityRegistry === "string";
}

/** Every pinned deployment that can bind an agent, for "use one of these" hints. */
export function deploymentsWithAgentIdentity(): EnsV2Deployment[] {
  return DEPLOYMENT_KEYS.map((k) => DEPLOYMENTS[k]).filter(hasAgentIdentity);
}
