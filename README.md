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
mm ensv2 available <name>    can this .eth label be registered? (asks the registrar; accounts for grace + v1 reservations)
mm ensv2 price <name>        ERC-20 cost to register, quoted by the registrar (--years n, default 1)
mm ensv2 faucet              mint Sepolia test USDC to this wallet (the beta's payment token) — Sepolia only
mm ensv2 register <name>     commit → wait → register, paid in USDC, resolver bound at registration; resumable
mm ensv2 resolver plan       predict THIS WALLET's resolver address + show the deploy calldata (read-only)
mm ensv2 resolver deploy     deploy this wallet's resolver, once (no-op if it exists) — signs via MetaMask policy
```

### Why `resolver deploy` exists

ENSv2 replaces the single shared Public Resolver with **one `PermissionedResolver` proxy per account**. A freshly registered name has no resolver, resolves to nothing, and can hold no records until one is deployed and assigned. `deploy` provisions it through the `VerifiableFactory`: it predicts the CREATE2 address (salt derived from the wallet address, `proxyLogic` read from chain), no-ops if code already exists there, builds the `deployProxy(...)` calldata with the three-argument `initialize(admin, ALL_ROLES, [])`, hands `{to, data, value: 0}` to the wallet executor, waits for the receipt, then re-reads the chain and requires the factory to attest the proxy. The plugin never sees a key.

Run `plan` first to see the address and the exact calldata. Deploying costs only gas.

### How `register` works

Three transactions, each signed through MetaMask policy (MFA if enabled), each verified on chain before the next:

1. `commit(makeCommitment(label, owner, secret, 0, resolver, duration, 0))` — the wallet's resolver is bound into the commitment, so `resolver deploy` must have run first. The secret and parameters are checkpointed to `~/.mm-plugin-ensv2/pending-registrations.json` (mode 0600) **before** this is sent.
2. `USDC.approve(registrar, total)` — only if the allowance is short; done during the commitment wait.
3. after chain time ≥ commit + 60 s: `register(...)` — pays the registrar, mints the name, sets the resolver in one call.

Then it checks the registry says `REGISTERED` to you and `UR.findResolver` returns your resolver at offset 0, and clears the checkpoint. Re-running after an interruption resumes with the same secret and commitment; an expired commitment (> 24 h) is re-committed. Price is quoted by the registrar (non-linear over duration; 28-day minimum) and paid in the oracle's ERC-20 — on Sepolia, `mm ensv2 faucet` mints it.

### Installing on a machine where `npm` stalls over IPv6

`mm plugins install` shells out to `npm`, which on some networks sits on a dead IPv6 socket to the registry for its full 5-minute fetch timeout. Force IPv4 for that one command:

```bash
NODE_OPTIONS=--dns-result-order=ipv4first mm plugins install file:$PWD/estmcmxci-mm-plugin-ensv2-0.1.0.tgz --accept-permissions
```

**Upgrading an installed plugin requires an uninstall first** (Agent Wallet 6.2.0). Installing a newer tarball over an approved plugin does not re-run the consent screen — the stored approval keeps the old version and command list, and the runtime gate then denies every command with `did not declare the 'wallet-read' capability`. Bumping the version does not help. Reported upstream; until fixed:

```bash
NODE_OPTIONS=--dns-result-order=ipv4first mm plugins uninstall @estmcmxci/mm-plugin-ensv2
NODE_OPTIONS=--dns-result-order=ipv4first mm plugins install file:$PWD/estmcmxci-mm-plugin-ensv2-<version>.tgz --accept-permissions
```

All commands run the same fail-closed gate first. `whois` and `resolver` locate the registry that actually holds the name (`UR.findParentRegistry`) rather than assuming the `.eth` registry — a subname's entry lives in its parent's subregistry, and reading the root for it returns a plausible-looking "AVAILABLE" for a name that is in fact registered.

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
