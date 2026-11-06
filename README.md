# @estmcmxci/mm-plugin-ensv2

[![npm](https://img.shields.io/npm/v/@estmcmxci/mm-plugin-ensv2?color=1c2123&label=npm)](https://www.npmjs.com/package/@estmcmxci/mm-plugin-ensv2) [![docs](https://img.shields.io/badge/docs-mm--ensv2.estmcmxci.co-1c2123)](https://mm-ensv2.estmcmxci.co)

ENSv2 names and ERC-8004 agent identity, natively inside the [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) CLI (`mm`). An agent wallet can register an ENSv2 name it owns, deploy its own resolver, mint an ERC-8004 agent bound to that name, publish the ENSIP-25/26 records that make it discoverable, and set the name as its primary name — every signature routed through MetaMask policy and MFA, every write verified on chain before the command returns.

**Mainnet and Sepolia, fail-closed on both.** ENSv2 went live on Ethereum mainnet on 2026-10-27, and this plugin pins it: `--deployment mainnet` (chain 1) works for everything, ERC-8004 agent binding included. **A read defaults to mainnet; a write has no default at all.** `ensv2 whois`, `price`, `status` and the other reads answer about chain 1, where the real names are. Anything that sends a transaction — `register`, `provision`, `faucet`, `records set`, `primary set`, `resolver deploy`, `agent register`, `agent set-uri`, `jobs resume` — refuses until you name a deployment, with `--deployment`, `--chain`, or `MM_ENSV2_DEPLOYMENT`. A testnet default used to stand in for safety and did the opposite: forget the flag and the run registers a name, binds an agent to it, publishes its records and verifies every one of them — convincing, worthless, reported as a success. Refusing to guess is the plugin's first invariant, and a write is where guessing costs the most. Two older Sepolia tables remain pinned (`hackathon`, and the dead `beta`) so existing jobs still resolve; see [Which deployment](#which-deployment). The plugin never falls back to ENSv1 behaviour, on any chain. Docs, explainer and live evidence: **https://mm-ensv2.estmcmxci.co** (every page is also Markdown: append `.md`, or fetch `/llms.txt`).

## Sixty seconds

```bash
mm ensv2 status                        # is this chain really serving ENSv2? fail-closed checks, refuses otherwise
mm ensv2 faucet --deployment sepolia   # 100 test USDC, this deployment's payment token
mm ensv2 provision myagent --deployment sepolia --agent-uri https://agent.example/agent.json --endpoints web=https://agent.example
mm ensv2 primary set myagent.eth --deployment sepolia   # the wallet now resolves back to its name
```

`provision` runs resolver, commit, approve, register, agent bind and records as **one resumable job**. Kill it anywhere and run it again. It never pays twice.

## Install

Requires MetaMask Agent Wallet **6.2.x or 7.x** (`mm --version`) — verified on 6.2.0 and 7.3.0, from one install — Node 20+, and a wallet with a little Sepolia ETH (a full provisioning run is about 1.2M gas).

```bash
mm config set experimentalPlugins true
```

### From npm — currently blocked by a host bug, use the tarball route below

The package is published, but Agent Wallet has a bug in its post-install consent hook: a plugin installed **from the registry by name** is reported as `installed`, then immediately removed, even though `oclif.manifest.json` is shipped and npm puts it on disk. Confirmed on **both 6.2.0 and 7.3.0** against 0.9.0 — two majors apart, so this is not waiting on a point release, and on 7.3.0 it now fails silently with no error text at all. Installs from a tarball take a different branch of that hook and work. Until it is fixed, fetch the very same artifact from npm as a tarball and install that:

```bash
npm pack @estmcmxci/mm-plugin-ensv2            # downloads estmcmxci-mm-plugin-ensv2-<version>.tgz from the registry
NODE_OPTIONS=--dns-result-order=ipv4first mm plugins install file:$PWD/estmcmxci-mm-plugin-ensv2-<version>.tgz --accept-permissions
mm ensv2 status
```

`--accept-permissions` consents to the capabilities the plugin declares: `wallet-read` for every command, `wallet-submit` only for the commands that send a transaction. Install the **packed tarball**, never a directory: a directory install symlinks the plugin, and its own `node_modules/@metamask/agent-wallet` then shadows the running CLI (`window.addEventListener is not a function`).

### Two more host quirks

- **Upgrading needs an uninstall first.** 6.2.0 does not refresh a plugin's consent record when a newer version is installed over an approved one; the runtime gate then denies every command with `did not declare the 'wallet-read' capability`. Bumping the version does not help. `mm plugins uninstall @estmcmxci/mm-plugin-ensv2`, then install.
- **npm can stall over IPv6.** `mm plugins install` shells out to `npm`, which on some networks sits on a dead IPv6 socket for its full fetch timeout. The `NODE_OPTIONS=--dns-result-order=ipv4first` prefix above forces IPv4 for that one command.

### Verify

`mm ensv2 status` must show `isV2: true` and eight passing checks against the default `mainnet` table — that is ENSv2 on chain 1. `mm ensv2 status --deployment sepolia` must also pass, with the same eight. `mm ensv2 status --chain 8453` must refuse: the plugin pins no deployment there, and refusing rather than guessing is its first invariant.

## For agents

Every command accepts `--json`. The host wraps the result as `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code", "message", "hint" } }`. `error.code` is stable (`ENSV2_*` for the commands, the program's frozen `E_*` codes for the job engine) and `error.hint` always names the next action. The full code table is generated from source on the docs site: https://mm-ensv2.estmcmxci.co/reference/errors.

| Step | Command | Precondition | Verify in `data` |
|---|---|---|---|
| 0 | `mm ensv2 status --json` | — | `isV2 === true`, every `checks[].ok` |
| 1 | `mm ensv2 resolver deploy --json` | Sepolia ETH | `verified === true` |
| 2 | `mm ensv2 available NAME.eth --json` | — | `available === true` |
| 3 | `mm ensv2 faucet --json` | Sepolia | `balanceAfter` covers the quote |
| 4 | `mm ensv2 register NAME.eth --json` | 1–3 | `status === "REGISTERED"`, `resolverBound` |
| 5 | `mm ensv2 agent register NAME.eth --uri URI --json` | 4; URI serves an ERC-8004 registration file | `verified.bindingMatches && verified.ownerIsController` |
| 6 | `mm ensv2 records set NAME.eth … --link-agent ID --json` | 5 | `verified === true` |
| 7 | `mm ensv2 primary set NAME.eth --json` | 6 wrote `addr` | `verified === true` |

Or steps 1–6 as one job: `mm ensv2 provision NAME … --json`, then `mm ensv2 jobs show JOBID --json`.

Rules that keep you out of trouble: **never re-send a write because a call failed** (a failed call is not a failed transaction; re-run the same command and it re-derives state from chain, or read `jobs show`); every write has an inspectable plan (`resolver plan`, `provision --dry-run`, `records get`, `primary get`); every command is idempotent for the same inputs; **mainnet writes spend real USDC**, and no write has a default deployment at all: omit `--deployment`/`--chain`/`MM_ENSV2_DEPLOYMENT` and you get `ENSV2_DEPLOYMENT_REQUIRED` rather than a guess. Reads default to mainnet. Check `deployment` in any `--json` output before and after a write; the commit secret under `~/.mm-plugin-ensv2/` is private, do not read or move it.

## Which deployment

Four deployments are pinned. Pick one with `--deployment`, available on every command; `MM_ENSV2_DEPLOYMENT` is the fallback. Naming a deployment implies its chain, so `--deployment mainnet` needs no `--chain 1`; naming a chain implies that chain's canonical deployment, so `--chain 1` needs no `--deployment mainnet`. An incoherent pair is refused rather than silently resolved either way.

**ENSv2 is live on Ethereum mainnet as of 2026-10-27.** Namechain was cancelled in February 2026 and ENSv2 shipped on L1 instead. Verified on chain: `isENSv2()` is true on `0xeEeE…EeEe`, the root → `.eth` → root hierarchy is consistent both ways, migrated names answer from the v2 `.eth` registry (`nick.eth` reads `REGISTERED` with its own resolver) and unmigrated ones fall through to `ENSV1Resolver` (`vitalik.eth`, `ens.eth` read `RESERVED`). Registration is priced in **real USDC** — about $8.00 a year for a free label — or real DAI.

| | `sepolia` | `mainnet` *(default on reads)* | `hackathon` | `beta` |
|---|---|---|---|---|
| What it is | ENS Labs' canonical ENSv2 testnet deployment | ENSv2 on Ethereum L1 | the **ETHOnline 2026** deployment | the original beta — **dead** |
| Chain | 11155111 | **1** | 11155111 | 11155111 |
| Deployment id | `ensv2-sepolia-2026-10-01` | `ensv2-mainnet-2026-10-18` | `ensv2-sepolia-hackathon-2026-09` | `ensv2-sepolia-2026-07-30` |
| Generation | **g3** | **g3** | g2 | g1 |
| Payment token | MockUSDC (open `mint`, use `faucet`) | **real USDC** (and real DAI) | its own MockUSDC | its own MockUSDC |
| ERC-8004 binding | yes | yes | yes | yes |
| Gate | 8 checks, passing | 8 checks, passing | 7 checks, passing | 5 checks, **failing — correctly** |
| Use it when | you are testing, and said so | reads, and any real name on L1 | you have names or agents there already | never; it is kept only so old jobs resolve |

```bash
mm ensv2 status                            # the read default: ENSv2 on L1
mm ensv2 status --deployment sepolia       # the canonical testnet table
mm ensv2 register myagent                  # refused: a write names its own deployment
mm ensv2 whois nick.eth --deployment mainnet
export MM_ENSV2_DEPLOYMENT=mainnet         # …or set it once for the session
```

**`beta` is dead, and that is what its refusal means.** Its `universalResolver` is `0xeEeE…EeEe` — the *same address* the canonical `sepolia` table uses, because it is an upgradeable proxy that ENS Labs upgraded in place, twice: to a third generation on 2026-09-15, and again at launch. The g1 table's other addresses are orphaned. `mm ensv2 status --deployment beta` reports `ENSv2 NOT ACTIVE`, which is the gate working: it asks the chain what that address is *currently* serving rather than trusting the table, and refuses to transact against a deployment it no longer describes. The table stays pinned so a job, receipt or verification result written against `ensv2-sepolia-2026-07-30` still resolves.

**Three generations, three gates, and no gate accepts another's contracts.** What actually moved:

| Concern | g1 (`beta`) | g2 (`hackathon`) | g3 (`sepolia`, `mainnet`) |
|---|---|---|---|
| Version probe | `supportsInterface(0xf99a5e06)` | `supportsInterface(0x1a6cc9f0)` | **`isENSv2()` is true; both ids are `false`** |
| `isENSv2()` | reverts | returns `true` | returns `true` |
| Registry navigation (`findCanonicalRegistry`, `findParentRegistry`) | on the Universal Resolver | on a separate `UniversalHelper`; the UR reverts | same as g2 |
| Resolver record setters | `setAddr` / `setText(bytes32 node, …)` | `setAddress` / `setText(bytes dnsName, …)` — no `setAddr` at all | same as g2 |
| Resolver initializer | `initialize(address,uint256,bytes[])` | `initialize(Grant[],bytes[])` | same as g2 |
| Resolver CREATE2 salt scheme | identical | identical | identical |
| Forward + reverse resolution | `findResolver` / `resolve` / `reverse` on the UR | identical | identical |

**g3 is g2's contracts.** The launch deployments and the ETHOnline one were built from the same sources, and the deployed bytecode was compared selector by selector on 2026-10-27 to prove it: `ETHRegistrar` is the same 8037 bytes with the same entry points on all three, `PermissionedResolverImpl` exposes exactly the same setters and initializer, `VerifiableFactory` and `ETHRegistry` match to the byte. So one set of encoders serves both generations, and g3 exists as a separate generation for exactly one reason — its Universal Resolver no longer advertises the g2 ERC-165 interface id, while still answering `isENSv2()`. That is the gate's business, not the encoders'. Upstream `ensdomains/ens-cli` made the same switch to `isENSv2()`.

**Names and agents are per deployment.** A registration, a resolver, a primary name and an ERC-8004 binding all belong to the deployment they were made on. `mm ensv2 whois agent.eth` and `mm ensv2 whois agent.eth --deployment mainnet` are two different questions with two different answers; a name taken on one may well be free on the other; and a provisioning job created under one deployment refuses to resume under another (`E_UNSUPPORTED_DEPLOYMENT`). Each Sepolia deployment has its own test USDC, so `mm ensv2 faucet --deployment hackathon` mints a *different* token from the canonical table's.

**What mainnet does differently.** Agent binding works here, and through 0.9.0 it did not. `Adapter8004` is live on chain 1 at `0xde152AfB…` — *not* the Sepolia address `0x7621630c…`, which has no code on mainnet. This plugin tested the Sepolia address against chain 1, concluded there was no adapter, omitted it from the table, and refused `agent register`, `agent info` and `agent set-uri` on L1 for no reason; the manifest declared those three Sepolia-only on top of that, so the host refused them before the plugin even ran. Both are fixed. Each chain also has its **own** ERC-8004 IdentityRegistry — `0x8004A169FB…` on mainnet, `0x8004A818BF…` on Sepolia, picked by the adapter's own `identityRegistry()` — and 0.9.0 pinned Sepolia's for mainnet, so an ENSIP-25 key written on L1 pointed readers at a registry no mainnet agent appears in. What is genuinely mainnet-only: registration spends **real USDC** (about $8.00 a year), and `faucet` stays Sepolia-only because real USDC has no open `mint`.

## Commands

```
mm ensv2 status              is this chain serving ENSv2, and does the deployment table agree?
mm ensv2 resolve <query>     name → address, or 0x address → primary name
mm ensv2 whois <name>        status, expiry, owner, token id, registration epoch, resolver, subregistry
mm ensv2 resolver <name>     which resolver answers for the name: its own, an ancestor's, or none
mm ensv2 available <name>    can this .eth label be registered? (asks the registrar; accounts for grace + v1 reservations)
mm ensv2 price <name>        ERC-20 cost to register, quoted by the registrar (--years n, default 1)
mm ensv2 faucet              mint Sepolia test USDC to this wallet (this deployment's payment token) — Sepolia only
mm ensv2 register <name>     commit → wait → register, paid in USDC, resolver bound at registration; resumable
mm ensv2 agent register <name> --uri <agentURI>   mint an ERC-8004 agent via Adapter8004, bound to your name (one tx)
mm ensv2 agent info <name> [--agent-id n]         the binding, orphan check, controller check, NFT holder, agentURI
mm ensv2 agent set-uri <name> --uri <agentURI>    point the bound agent's agentURI at its registration JSON (one tx; no-op if set)
mm ensv2 records set <name> [...]   addr + profile (ENSIP-5/12/18) + agent-context/agent-endpoint (ENSIP-26) + ENSIP-25 link, ONE tx
mm ensv2 records get <name>         the record set as a stranger sees it, read through the Universal Resolver
mm ensv2 primary get [address]      the address's primary name: raw reverse record, forward check, UR round-trip
mm ensv2 primary set <name>         make <name> this wallet's primary name (one tx; name must already resolve to you)
mm ensv2 resolver plan       predict THIS WALLET's resolver address + show the deploy calldata (read-only)
mm ensv2 resolver deploy     deploy this wallet's resolver, once (no-op if it exists) — signs via MetaMask policy
mm ensv2 provision <name> --agent-uri <uri> [...]   resolver → register → ERC-8004 bind → records as ONE resumable job
mm ensv2 jobs list [--all]          the provisioning jobs on this machine
mm ensv2 jobs show <jobId>          a job's intent, record, step receipts and errors (secret redacted)
mm ensv2 jobs resume <jobId>        continue a job; re-derives every step from chain, never repeats a paid step
mm ensv2 jobs abandon <jobId>       set a finished or failed job aside (renamed, kept) so provision can start over
```

Every command above also accepts:

```
--deployment <sepolia|mainnet|hackathon|beta>
                                which pinned deployment to talk to (env MM_ENSV2_DEPLOYMENT). Reads
                                default to mainnet; writes REQUIRE this (or --chain). Implies its own
                                chain, so --deployment mainnet needs no --chain 1.
--chain <id>                    EVM chain id: 1 or 11155111 (default 1 on reads). Implies that chain's
                                canonical deployment. Any other chain is refused.
--json                          machine-readable output
```

On `jobs show` and `jobs abandon` the flag is validated but has no effect — those are addressed by job id, and the job's own deployment is what they report. `jobs list` lists every deployment's jobs unless you name one.

`agent register`, `agent info`, `agent set-uri` and `faucet` are Sepolia-only and declare it in the manifest; the other 18 commands accept chain 1.

Full reference with every flag, generated from the plugin's manifest: https://mm-ensv2.estmcmxci.co/reference/commands.

## Live on Sepolia

Two wallets, two names, two agents, every transaction verified independently with `cast` against a public RPC — receipts, decoded calldata, contract reads, Universal Resolver `resolve()` and `reverse()`.

| Name | Owner | Resolver | Agent | Primary |
|---|---|---|---|---|
| `grilledcheese.eth` | `0x0943…7EE1` | `0xeda43c…D282` | #10058 | yes |
| `sesquipedalian.eth` | `0x9bFF…034b` | `0x94a26d…27af` | #10059 | yes |

The second run was a cold wallet start to finish, including a real network drop mid-registration that the resume path handled with no duplicate payment. Every hash, block and gas figure: https://mm-ensv2.estmcmxci.co/evidence.

## How it works

### Detection: fail closed

All commands run the same fail-closed gate first. `whois` and `resolver` locate the registry that actually holds the name (`UR.findParentRegistry`) rather than assuming the `.eth` registry — a subname's entry lives in its parent's subregistry, and reading the root for it returns a plausible-looking "AVAILABLE" for a name that is in fact registered.

`whois` reports `owner` only while `REGISTERED` (`latestOwner` is stale after expiry) and surfaces the **registration epoch** alongside the token id: token ids change on any role grant or revoke, so `(registry, canonicalId, registrationEpoch)` is the anchor to key identity off, never the token id.

`status` fails closed. If the Universal Resolver is not serving ENSv2, or the chain's registry hierarchy disagrees with the configured deployment, the command exits non-zero instead of quietly behaving like ENSv1. Every write command added to this plugin runs the same check first.

The gate is **generation-aware**: which reads it performs is decided by the selected deployment's generation, and a table of one generation can never be accepted against another's contracts.

On `sepolia` and `mainnet` (g3) it performs eight reads and reports each one:

1. `UniversalResolver.isENSv2()` returns `true` — the launch UR advertises no `IUniversalResolverV2` id, so the version question goes to the function directly
2. `UniversalResolver.supportsInterface(0xf99a5e06)` is **false** — no cross-accepting a g1 deployment
3. `UniversalResolver.supportsInterface(0x1a6cc9f0)` is **false** — nor a g2 one
4. `UniversalHelper.findCanonicalRegistry("eth")` equals the configured `.eth` registry — the UR reverts on this call
5. `RootRegistry.getSubregistry("eth")` points at that registry (forward)
6. that registry's `getParent()` points back at the root with label `eth` (backward)
7. `VerifiableFactory.proxyLogic()` matches the configured proxy logic, so CREATE2 resolver prediction is sound
8. `UniversalResolver.findResolver("eth")` is callable — resolution stayed on the UR, and every read goes through it

On `beta` (g1) it performs five reads:

1. `UniversalResolver.supportsInterface(IUniversalResolverV2 = 0xf99a5e06)` is true
2. `UniversalResolver.findCanonicalRegistry("eth")` equals the configured `.eth` registry
3. `RootRegistry.getSubregistry("eth")` points at that registry (forward)
4. that registry's `getParent()` points back at the root with label `eth` (backward)
5. `VerifiableFactory.proxyLogic()` matches the configured proxy logic, so CREATE2 resolver prediction is sound

On `hackathon` (g2) it performs seven, because two things had moved by then:

1. `UniversalResolver.supportsInterface(IUniversalResolverV2 = 0x1a6cc9f0)` is true — a different id on this generation
2. `UniversalResolver.supportsInterface(0xf99a5e06)` is **false** — the explicit refusal to cross-accept a g1 deployment
3. `UniversalHelper.findCanonicalRegistry("eth")` equals the configured `.eth` registry — the UR reverts on this call here
4. `RootRegistry.getSubregistry("eth")` points at that registry (forward)
5. that registry's `getParent()` points back at the root with label `eth` (backward)
6. `VerifiableFactory.proxyLogic()` matches the configured proxy logic
7. `UniversalResolver.findResolver("eth")` is callable — resolution itself stayed on the UR, and every read goes through it

The opening checks are what make the three un-crossable, and they are measured rather than assumed. On chain: the g1 UR answers `false` to the g2 id and reverts on `isENSv2()`; the g2 UR answers `false` to the g1 id; both g3 URs answer `false` to *both* ids while answering `isENSv2()` true, and still report ERC-165 itself (`0x01ffc9a7` → true), so those are real answers and not a missing function. This matters most for the live case where `beta` and `sepolia` name the same, upgraded, address.

### Why `resolver deploy` exists

ENSv2 replaces the single shared Public Resolver with **one `PermissionedResolver` proxy per account**. A freshly registered name has no resolver, resolves to nothing, and can hold no records until one is deployed and assigned. `deploy` provisions it through the `VerifiableFactory`: it predicts the CREATE2 address (salt derived from the wallet address, `proxyLogic` read from chain), no-ops if code already exists there, builds the `deployProxy(...)` calldata with the initializer that deployment's implementation actually exposes — the three-argument `initialize(admin, ALL_ROLES, [])` on `beta` (g1), and `initialize([{admin, roles}], [])` on `sepolia`, `mainnet` and `hackathon`, where `roles` is composed from `PermissionedResolverLib`'s named constants rather than a blanket literal — hands `{to, data, value: 0}` to the wallet executor, waits for the receipt, then re-reads the chain and requires the factory to attest the proxy. The plugin never sees a key.

Run `plan` first to see the address and the exact calldata. Deploying costs only gas.

### How `register` works

Three transactions, each signed through MetaMask policy (MFA if enabled), each verified on chain before the next:

1. `commit(makeCommitment(label, owner, secret, 0, resolver, duration, 0))` — the wallet's resolver is bound into the commitment, so `resolver deploy` must have run first. The secret and parameters are checkpointed to `~/.mm-plugin-ensv2/pending-registrations.json` (mode 0600) **before** this is sent.
2. `USDC.approve(registrar, total)` — only if the allowance is short; done during the commitment wait.
3. after chain time ≥ commit + 60 s: `register(...)` — pays the registrar, mints the name, sets the resolver in one call.

Then it checks the registry says `REGISTERED` to you and `UR.findResolver` returns your resolver at offset 0, and clears the checkpoint. Re-running after an interruption resumes with the same secret and commitment; an expired commitment (> 24 h) is re-committed. Price is quoted by the registrar (non-linear over duration; 28-day minimum) and paid in the oracle's ERC-20 — on Sepolia, `mm ensv2 faucet` mints it.

### Paying with ETH: `--pay-with eth`

A wallet short on the payment token stops, and the advice now depends on the chain: Sepolia is told to run `faucet`, mainnet is told to buy the USDC with the ETH it already holds through the host's own `mm swap`. (`mm swap` refuses testnets outright — `UNSUPPORTED_CHAIN`, "Swaps are not supported on Ethereum Sepolia" — which is why only chain 1 is sent there.)

`--pay-with eth`, on `register`, `provision` and `jobs resume`, does that buying inside the run instead:

```bash
mm ensv2 register myagent --deployment mainnet --pay-with eth
```

One extra transaction, `multicall(deadline, [exactOutputSingle, refundETH])` on Uniswap v3's SwapRouter02: it wraps the ETH, buys **exactly** the token units the wallet is short, and refunds the rest atomically. Exact output is the point — the host's `mm swap` and every DEX aggregator are exact-*in*, so they can land under the quote (which reverts `register`) or over it (which leaves dust). Ported from ENS Labs' own [apps-monorepo#1684](https://github.com/ensdomains/apps-monorepo/pull/1684), which added the same path to the ENS manager checkout, with its guards intact:

- the cheapest routing pool of 0.05% / 0.3% / 1%, at its 2% slippage limit, must cost no more than the Chainlink ETH/USD price of the tokens plus 3% (floor: 2 whole tokens). Stale rounds, non-positive answers and rounds answered before they were asked are refused;
- the ETH it may spend is derived from the spend ceiling you already accepted, at the oracle price — nothing new is signed, and the intent's EIP-712 projection is untouched;
- the wallet must cover the swap plus twice its estimated gas;
- a swap is checkpointed to `~/.mm-plugin-ensv2/pending-swaps.json` (mode 0600), keyed by chain and wallet, **before** it is sent. A run that finds one still inside its deadline stops rather than buying again; past the deadline (plus a five-minute clock margin) the router refuses the old call, so a fresh swap is safe. How much to buy is always re-derived from the on-chain balance, never from the record, so a swap that landed after a cancelled run is counted rather than repeated.

It is never implied: a swap spends the wallet's ETH, so it has to be asked for, every run — the same reason `--deployment mainnet` is not the default. On Sepolia `faucet` remains the better answer, and per #1684's own measurements Sepolia's pools price ETH near $28,000 against Chainlink's ~$2,266, so a swap there proves nothing about mainnet.

One consequence worth knowing: `payment_settle` is in provisioning-job 1.0.0's step enum but not in step-receipt 1.0.0's, and both schemas are frozen. The swap therefore carries no step receipt and does not appear in a job's transaction list; it is reported in the run's log and in the checkpoint file while in flight. Nothing about the registration's own receipts changes.

### Durable jobs: `provision` and `jobs`

`provision` runs the whole ladder — resolver deploy, commit, approve, wait, register, ERC-8004 bind through Adapter8004, and the record set (addr, description, url, `agent-endpoint[…]`, `agent-context`, and the ENSIP-25 link) — as **one job** that survives the process dying at any point.

```bash
mm ensv2 provision myagent --agent-uri https://agent.example/agent.json \
  --description "My agent" --endpoints web=https://agent.example
mm ensv2 provision myagent --no-identity            # name + records only, no ERC-8004
mm ensv2 provision myagent --agent-uri ... --dry-run  # intent + plan + what each step sees on chain; nothing written or sent
```

**What a job is.** A file at `~/.mm-plugin-ensv2/jobs/<jobId>.json` (mode 0600) holding three things: the *provisioning intent* (the program's `provisioning-intent` 1.0.0 object for the direct-custody path, with its EIP-712 digest computed but not signed), the *job record* (`provisioning-job` 1.0.0: state, facts, an ordered step list, and a `step-receipt` for every transaction), and a *private* section with the commit/reveal tuple and its secret. Every write is validated against the frozen schemas vendored under `schemas/` (see `schemas/PROVENANCE.md`); the secret is never in the record, only a `commitmentSecretRef` handle, and `jobs show` redacts it. The final verification is a `verification-result` 1.0.0 computed from two independent RPC endpoints (`--verify-rpc`, `MM_ENSV2_VERIFY_RPC`, default publicnode); a single endpoint cannot produce a `verified` outcome.

**The job id is deterministic.** It derives from (chain, name, owner, intent hash), so running the same `provision` again does not start a second job — it finds the existing one and resumes it. If a job for the name already exists with *different* inputs (another duration, other records, a different agent URI) the command refuses with `E_IDEMPOTENCY_CONFLICT` and tells you which job to `jobs resume` or inspect, rather than committing or paying twice. A checkpoint left by `register` in `pending-registrations.json` for the same label is adopted into a new job (same secret and commitment, nothing re-committed) and then removed; `register` itself is unchanged and keeps using that file.

**Resume re-derives everything from chain first.** Every step observes before it acts: does code exist at the predicted resolver address and does the factory attest it; is the commitment on chain and how old is it; does the allowance cover the ceiling; does the registry say the name is `REGISTERED` to you; is an agent already bound to the name's current token (`AgentBound` scan + `bindingOf`); do the records already read back through the Universal Resolver. A step the chain shows done is skipped, whatever the job file says. That is what makes a crash after any transaction landed harmless — the next run finds the effect and moves on — and it is also why a re-run is a no-op for a completed job.

**A paid or irreversible step is never re-sent when its outcome is unknown.** The wallet reports only two outcomes *before* anything is signed — the approval was denied (`E_POLICY_DENIED`) or its window expired (`E_MFA_REQUIRED`) — and for those the step is marked failed and the next run simply tries again. Everything else without a confirmed result is **unknown**: the process died between sending and confirming, the wallet errored after the request went out, the server stopped tracking the transaction (`BROADCAST_TRACKING_EXPIRED` / `CONFIRMATION_TRACKING_EXPIRED`), or polling was cut off. Then the step stays in flight and the job **halts** with an `indeterminate` error (`E_RECEIPT_UNAVAILABLE`, or `E_IDENTITY_BINDING_FAILED` for the bind) that says exactly what to check: the transaction hash if one was recorded, the wallet job (`mm wallet requests watch <pollingId>`, recorded in the job's `executionPlane`), `mm wallet requests list` for a pending approval, `whois`/`agent info`/`records get` for the effect. If the transaction is merely pending, wait and run the job again; it will be found on chain and skipped. Only when you have confirmed nothing landed and nothing is pending, run `mm ensv2 jobs resume <jobId> --resubmit-unconfirmed` to send it once more. A revert is only ever acted on once the receipt has been read: whether the wallet returned the hash or threw `TX_REVERTED` naming it, the engine records the receipt, confirms `status: reverted` from chain, marks the step retryable, and the **next** run retries it once — no step is ever retried twice within one run, and identity always re-enters at preflight (re-reads the current token id and the adapter implementation) before a bind. An agent whose binding was orphaned by a role change is terminal for the job: it will not mint a second agent on its own.

```bash
mm ensv2 jobs list                 # jobs that can still run; --all for completed/terminal too
mm ensv2 jobs show <jobId>         # intent, record, receipts, errors; private secret redacted
mm ensv2 jobs resume <jobId>       # same as re-running provision with the original arguments
mm ensv2 jobs resume <jobId> --max-spend 9   # raise this job's spend ceiling (after E_PRICE_EXCEEDS_MAX_SPEND); never lowers it
mm ensv2 jobs abandon <jobId>      # set a completed/terminal job aside so a fresh job can use the name (renamed, never deleted)
```

A completed or terminal job is a record, not a claim on the name: a new `provision` with other inputs is never blocked by it, and one with the *same* inputs is a no-op for a completed job or `E_JOB_TERMINAL` (with the `abandon` hint) for a failed one. Two runs for one name cannot both create a job — the job file is created exclusively and every later save is a compare-and-swap on its `revision`, so a run that loses the race stops without writing (`E_IDEMPOTENCY_CONFLICT`).

Every error the engine raises is one of the program's `errors` 1.0.0 codes, and the command's error code is that code; the hint is the schema's `recoveryAction`. A job's `resume` block records whether it is resumable, from which step, and what blocks it.

The one thing a job does not write is the reverse record. When a job completes, the success line ends with the follow-up: `mm ensv2 primary set <name>` (see *Primary name* below). The program's step enum already has a `reverse_record_set` step for it; it is left for a later rung.

### How `agent register` works — and its one limitation

Adapter8004 (`unruggable-labs/adapter`) mints an agent on the canonical ERC-8004 IdentityRegistry and binds it to a token you control; the adapter holds the NFT and you control it through the token. For an ENSv2 name, the token is the name's entry in **the registry that holds it** (located via `UR.findParentRegistry`, never assumed) with its **current** token id from `getState()`. The adapter's ERC-721 control check calls `ownerOf(tokenId)` on that registry, which the ENSv2 ERC-1155 singleton exposes. One transaction; the agent id is read from the `AgentBound` event and the binding, controller status, and NFT holder are re-read from chain before success is reported.

**The binding anchors on the token id, and ENSv2 regenerates that id on any role grant or revoke.** Bind, then delegate a role on the name → the binding points at a stale id. `agent info` reports `status: orphaned` when the bound id no longer matches the current one. Transfers and renewals do not change the id. A resource-anchored binding that survives role changes is being prepared upstream; until it lands, treat role changes on a bound name as a re-bind trigger.

`agent set-uri` repoints a bound agent's `agentURI` (the ERC-8004 registration JSON) through the adapter's `setAgentURI`, which forwards to the IdentityRegistry only if the caller controls the bound token; it refuses for orphaned bindings and is a no-op when the URI already matches. The two live agents point at the registration files this project's docs site serves under `/agents/<id>.json`.

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

### Primary name (`primary set`)

Forward resolution (`name → address`) lives on your resolver; the reverse direction (`address → name`) lives in a separate namespace, `addr.reverse`. **At ENSv2 launch that namespace is still v1 infrastructure**: the v2 root registry binds the `reverse` TLD to `ENSV1Resolver`, which mirrors the v1 registry, and the Universal Resolver's `reverse()` reads through it. So a primary name is set by calling the **v1 `ReverseRegistrar.setName(name)`** from the wallet itself — one transaction that claims `<you>.addr.reverse` and writes the name. This is what the ENS docs prescribe ("Reverse Resolution — At Launch") and what the official `ens-cli` does.

The registrar address is never trusted from the table. Before sending, the plugin walks `root.getResolver("reverse") → ENSV1Resolver.REGISTRY_V1() → v1Registry.owner(namehash("addr.reverse"))` and refuses if the result differs from the pinned value. It also refuses unless the name already forward-resolves to this wallet (a reverse record that does not round-trip is not a primary name — the Universal Resolver ignores it), and it verifies the round-trip through the Universal Resolver after the transaction. A second run is a no-op.

`primary get` shows both layers: what the v1 reverse record literally says (`rawName`, `v1Resolver`) and what a stranger sees (`primaryName`, only non-null when the round-trip holds). ENSv2's own per-chain `L2ReverseRegistrar` with signature-based claims is "upcoming" in the docs; when the reverse namespace migrates, the derivation above will stop matching and this command will refuse rather than write to the wrong place.

## Build and run locally

```bash
npm install
npm run build          # tsc + oclif manifest
npm test               # build + node:test — the schema conformance suite and the interruption matrix (no network)
npm run check                      # the five fail-closed checks, public Sepolia RPC, no wallet needed
npm run check -- whois name.eth
npm run check -- resolver name.eth
npm run check -- resolve name.eth  # or an 0x address
npm run check -- primary 0xYourAddress
npm run check -- primary-plan name.eth 0xYourAddress
npm run check -- provision-plan <name> <owner> [agentURI|none] [years]   # the intent, job id, steps and what each observes; eth_call only
```

Then `npm pack` and install the tarball as above. The docs site lives in `site/` (Vocs); its reference pages are generated from this package's manifest and source by `site/scripts/generate.mjs`.

## Where the addresses come from

`src/lib/deployments.ts`, one table per deployment, each with per-field provenance comments.

For `sepolia` and `mainnet`: the *Sepolia (ENSv2)* and *Mainnet (ENSv2)* tables on [docs.ens.domains/learn/deployments](https://docs.ens.domains/learn/deployments), row for row, with a second independent table agreeing on every pinned address (`ensdomains/ensjs`, `packages/ensjs/src/clients/chain.ts`) and every derivable value re-derived live on 2026-10-27. Where sources disagree with each other, the table follows the two that agree and says so: `ens-cli` records a different mainnet `subregistryImplementation`, a field this plugin reads nowhere.

For `beta`: the then-official ENS deployment table, the checked-in Sepolia artifacts in `ensdomains/contracts-v2`, and `ensdomains/ens-cli` @ 256cc45, all cross-checked and verified live in September 2026. All three have since moved on; the table is kept as the historical record a 0.7.x job was written against.

For `hackathon`: the ETHOnline deployments page, row for row, derived live on 2026-09-04 and re-verified 2026-10-27.

No table is trusted blindly: `status` re-derives the registry from the deployment's own navigation surface and refuses if the table disagrees; the resolver factory's clone target, the adapter implementation (EIP-1967 slot) and the reverse registrar (root → reverse TLD resolver → v1 registry → `owner(addr.reverse)`) are each re-derived on use. Full generated table, all four deployments: https://mm-ensv2.estmcmxci.co/reference/deployment.

## Design notes

- Detection is ported from `ensdomains/ens-cli` (`src/lib/context.ts`) with its fail-open default inverted.
- The probe depends on the generation. On g1 it is `supportsInterface(0xf99a5e06)`, because `isENSv2()` reverts on that Universal Resolver; on g2, `supportsInterface(0x1a6cc9f0)`; on g3 it is `isENSv2()` itself, because the launch UR advertises neither older id. Each gate also asserts the *other* generations' ids absent, so no two can be confused.
- The host-provided `ctx.publicClient(chainId)` carries no `chain` object; every read passes an explicit address.
- Signing never happens in the plugin. Write commands build calldata and hand it to `ctx.walletExecutor()`.
- The job engine (`src/lib/provision.ts`) imports nothing from the host: it reads through `ProvisionChain` and sends through `Submit`, so the interruption matrix runs against an in-memory chain that applies the engine's real calldata (`test/mock-chain.mjs`), and `scripts/check.mjs provision-plan` runs the planner against public Sepolia.
- The schemas under `schemas/` are consumed, never edited (D-011 additive-only freeze). `src/lib/schema.ts` is a small draft 2020-12 validator covering exactly the keywords they use; `test/schema.test.mjs` requires the same answers as the program's ajv runner on all 75 vendored fixtures.

## License

MIT. Built by 𝔪✶ [Émile Marcel Agustín](https://estmcmxci.co).
