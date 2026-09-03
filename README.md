# @estmcmxci/mm-plugin-ensv2

ENSv2 for the [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) CLI (`mm`). Sepolia only, by design — ENSv2 is a beta with non-final interfaces and this plugin refuses to run against anything else.

## Install

```bash
mm config set experimentalPlugins true          # the plugin system itself is beta
mm plugins install @estmcmxci/mm-plugin-ensv2   # once published
```

npm installs are verified against the registry; no unverified-install flag is needed.

## Commands

```
mm ensv2 status              is this chain serving ENSv2, and does the deployment table agree?
mm ensv2 resolve <query>     name → address, or 0x address → primary name
mm ensv2 whois <name>        status, expiry, owner, token id, registration epoch, resolver, subregistry
mm ensv2 resolver <name>     which resolver answers for the name: its own, an ancestor's, or none
```

All four run the same fail-closed gate first. `whois` and `resolver` locate the registry that actually holds the name (`UR.findParentRegistry`) rather than assuming the `.eth` registry — a subname's entry lives in its parent's subregistry, and reading the root for it returns a plausible-looking "AVAILABLE" for a name that is in fact registered.

`whois` reports `owner` only while `REGISTERED` (`latestOwner` is stale after expiry) and surfaces the **registration epoch** alongside the token id: token ids change on any role grant or revoke, so `(registry, canonicalId, registrationEpoch)` is the anchor to key identity off, never the token id.

`status` fails closed. If the Universal Resolver is not serving ENSv2, or the chain's registry hierarchy disagrees with the configured deployment, the command exits non-zero instead of quietly behaving like ENSv1. Every write command added to this plugin runs the same check first.

It performs five reads and reports each one:

1. `UniversalResolver.supportsInterface(IUniversalResolverV2)` is true
2. `UniversalResolver.findCanonicalRegistry("eth")` equals the configured `.eth` registry
3. `RootRegistry.getSubregistry("eth")` points at that registry (forward)
4. that registry's `getParent()` points back at the root with label `eth` (backward)
5. `VerifiableFactory.proxyLogic()` matches the configured proxy logic, so CREATE2 resolver prediction is sound

## Build and run locally

```bash
npm install
npm run build          # tsc + oclif manifest
npm run check                      # the five fail-closed checks, public Sepolia RPC, no wallet needed
npm run check -- whois name.eth
npm run check -- resolver name.eth
npm run check -- resolve name.eth  # or an 0x address
```

Install into `mm` from a **packed tarball**, not the directory:

```bash
npm pack
mm plugins install file:$PWD/estmcmxci-mm-plugin-ensv2-0.1.0.tgz --accept-permissions
mm ensv2 status
mm ensv2 status --json
```

Why the tarball: a directory install symlinks the plugin, and this directory's own `node_modules/@metamask/agent-wallet` then shadows the running CLI — every command dies with `window.addEventListener is not a function`. The tarball is copied into the CLI's plugin directory and resolves the host's wallet correctly.

## Where the addresses come from

`src/lib/deployments.ts`. Provenance is the checked-in Sepolia deployment artifacts in `ensdomains/contracts-v2`, cross-checked against `ensdomains/ens-cli` and verified live. They are never trusted blindly: `status` re-derives the registry from chain and refuses if the table disagrees.

## Design notes

- Detection is ported from `ensdomains/ens-cli` (`src/lib/context.ts`) with its fail-open default inverted.
- The probe is `supportsInterface(0xf99a5e06)`, not `isENSv2()` — the latter is declared in some copies of the contracts source but does not exist on the deployed Universal Resolver.
- The host-provided `ctx.publicClient(chainId)` carries no `chain` object; every read passes an explicit address.
- Signing never happens in the plugin. Write commands build calldata and hand it to `ctx.walletExecutor()`.
