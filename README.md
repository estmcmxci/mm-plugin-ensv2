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
mm ensv2 agent register <name> --uri <agentURI>   mint an ERC-8004 agent via Adapter8004, bound to your name (one tx)
mm ensv2 agent info <name> [--agent-id n]         the binding, orphan check, controller check, NFT holder, agentURI
mm ensv2 records set <name> [...]   addr + profile (ENSIP-5/12/18) + agent-context/agent-endpoint (ENSIP-26) + ENSIP-25 link, ONE tx
mm ensv2 records get <name>         the record set as a stranger sees it, read through the Universal Resolver
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

### How `agent register` works — and its one limitation

Adapter8004 (`unruggable-labs/adapter`) mints an agent on the canonical ERC-8004 IdentityRegistry and binds it to a token you control; the adapter holds the NFT and you control it through the token. For an ENSv2 name, the token is the name's entry in **the registry that holds it** (located via `UR.findParentRegistry`, never assumed) with its **current** token id from `getState()`. The adapter's ERC-721 control check calls `ownerOf(tokenId)` on that registry, which the ENSv2 ERC-1155 singleton exposes. One transaction; the agent id is read from the `AgentBound` event and the binding, controller status, and NFT holder are re-read from chain before success is reported.

**The binding anchors on the token id, and ENSv2 regenerates that id on any role grant or revoke.** Bind, then delegate a role on the name → the binding points at a stale id. `agent info` reports `status: orphaned` when the bound id no longer matches the current one. Transfers and renewals do not change the id. A resource-anchored binding that survives role changes is being prepared upstream; until it lands, treat role changes on a bound name as a re-bind trigger.

### The record set (`records set`)

One transaction — a `multicall` on the wallet's own resolver — writes everything that makes the name an agent identity, and only the keys whose on-chain value differs:

| Key | Spec | Rule enforced before signing |
|---|---|---|
| `addr` | ENSIP-1 | defaults to the wallet; `--addr none` to skip |
| `description`, `url`, `avatar`, `alias` | ENSIP-5 / 12 / 18 | `description` ≤ 160 chars; `url` http(s); `avatar` must be `https://`, `ipfs://`, `data:image/…`, or `eip155:<chain>/erc721|erc1155:<address>/<id>` |
| `agent-context` | ENSIP-26 | free-form; a Markdown stub is generated if none is given and none exists |
| `agent-endpoint[mcp|a2a|web]` | ENSIP-26 | `--endpoints mcp=<url>,web=<url>`; URLs or `ipfs://`; unknown protocols allowed with a warning |
| `agent-registration[<erc7930 registry>][<id>]` | ENSIP-25 | `--link-agent <id>`; registry = the canonical ERC-8004 IdentityRegistry, ERC-7930-encoded; value `"1"` |

`records get` reads all of it **through the Universal Resolver** — never the resolver directly — and reports each key as `present`, `absent`, or `lookup_failed`, so an RPC outage never masquerades as "no record". ENSIP-25 defines no enumeration, so links are checked for the ids you pass (`--agent-ids`); an ensemble-cli `agent-ids` index is read for compatibility but never written. `agent info` performs the ENSIP-25 registry→ENS verification (`ensip25Linked`).

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
