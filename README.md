# @estmcmxci/mm-plugin-ensv2

[![npm](https://img.shields.io/npm/v/@estmcmxci/mm-plugin-ensv2?color=1c2123&label=npm)](https://www.npmjs.com/package/@estmcmxci/mm-plugin-ensv2) [![docs](https://img.shields.io/badge/docs-mm--ensv2.estmcmxci.co-1c2123)](https://mm-ensv2.estmcmxci.co)

ENSv2 names and ERC-8004 agent identity, natively inside the [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) CLI (`mm`). An agent wallet can register an ENSv2 name it owns, deploy its own resolver, mint an ERC-8004 agent bound to that name, publish the ENSIP-25/26 records that make it discoverable, and set the name as its primary name — every signature routed through MetaMask policy and MFA, every write verified on chain before the command returns.

**Sepolia only, by design.** ENSv2 is a beta with non-final interfaces; this plugin refuses to run against anything else, and it never falls back to ENSv1 behaviour. Two Sepolia deployments are pinned — the canonical beta (default) and ENS Labs' ETHOnline hackathon deployment (`--deployment hackathon`); see [Which deployment](#which-deployment). Docs, explainer and live evidence: **https://mm-ensv2.estmcmxci.co** (every page is also Markdown: append `.md`, or fetch `/llms.txt`).

## Sixty seconds

```bash
mm ensv2 status                        # is this chain really serving ENSv2? fail-closed checks, refuses otherwise
mm ensv2 faucet                        # 100 test USDC, the beta's payment token
mm ensv2 provision myagent --agent-uri https://agent.example/agent.json --endpoints web=https://agent.example
mm ensv2 primary set myagent.eth       # the wallet now resolves back to its name
```

`provision` runs resolver, commit, approve, register, agent bind and records as **one resumable job**. Kill it anywhere and run it again. It never pays twice.

## Install

Requires MetaMask Agent Wallet **6.2.0+** (`mm --version`), Node 20+, and a wallet with a little Sepolia ETH (a full provisioning run is about 1.2M gas).

```bash
mm config set experimentalPlugins true
```

### From npm — currently blocked by a host bug, use the tarball route below

The package is published, but Agent Wallet 6.2.0 has a bug in its post-install consent hook: a plugin installed **from the registry** is reported as `installed`, then immediately removed with `PLUGIN_MANIFEST_FILE_MISSING`, even though `oclif.manifest.json` is shipped and npm puts it on disk. Installs from a tarball take a different branch of that hook and work. Reported upstream. Until it is fixed, fetch the very same artifact from npm as a tarball and install that:

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

`mm ensv2 status` must show `isV2: true` and five passing checks. `mm ensv2 status --chain 1` must refuse: no mainnet deployment exists, and that refusal is the plugin's first invariant.

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

Rules that keep you out of trouble: **never re-send a write because a call failed** (a failed call is not a failed transaction; re-run the same command and it re-derives state from chain, or read `jobs show`); every write has an inspectable plan (`resolver plan`, `provision --dry-run`, `records get`, `primary get`); every command is idempotent for the same inputs; mainnet is refused; the commit secret under `~/.mm-plugin-ensv2/` is private, do not read or move it.

## Which deployment

Two ENSv2 deployments are pinned, **both on Sepolia (chain 11155111)**. Pick one with `--deployment`, available on every command; `MM_ENSV2_DEPLOYMENT` is the fallback, and the default is `beta`.

| | `beta` *(default)* | `hackathon` |
|---|---|---|
| What it is | The canonical ENSv2 Sepolia beta — the deployment `mm ensv2` has talked to since v0.1 | ENS Labs' dedicated deployment for the **ETHOnline 2026** hackathon |
| Deployment id | `ensv2-sepolia-2026-07-30` | `ensv2-sepolia-hackathon-2026-09` |
| Contract generation | g1 | **g2 — newer** |
| Lifetime | ongoing | **not announced; treat it as temporary** |
| Use it when | always, unless you need the other | you are building against the hackathon addresses |

```bash
mm ensv2 status --deployment hackathon
mm ensv2 whois grilledcheese.eth --deployment hackathon
export MM_ENSV2_DEPLOYMENT=hackathon    # …or set it once for the session
```

**They are different contract generations, and the gate never accepts one for the other.** `--deployment beta` run against the hackathon contracts is refused on its first check, and the reverse likewise. What actually moved between them:

| Concern | g1 (`beta`) | g2 (`hackathon`) |
|---|---|---|
| `IUniversalResolverV2` id | `0xf99a5e06` | `0x1a6cc9f0` |
| `isENSv2()` | reverts | returns `true` |
| Registry navigation (`findCanonicalRegistry`, `findParentRegistry`) | on the Universal Resolver | on a separate `UniversalHelper`; the UR reverts |
| Resolver record setters | `setAddr` / `setText(bytes32 node, …)` | `setAddress` / `setText(bytes dnsName, …)` — no `setAddr` at all |
| Resolver initializer | `initialize(address,uint256,bytes[])` | `initialize(Grant[],bytes[])` |
| Resolver CREATE2 salt scheme | identical | identical |
| Forward + reverse resolution | `findResolver` / `resolve` / `reverse` on the UR | identical |
| ERC-8004 adapter + IdentityRegistry | same contracts | same contracts |

**Names and agents are per deployment.** A registration, a resolver, a primary name and an ERC-8004 binding all belong to the deployment they were made on. `mm ensv2 whois agent.eth` and `mm ensv2 whois agent.eth --deployment hackathon` are two different questions with two different answers; a name that is taken on one may well be free on the other; and a provisioning job created under one deployment refuses to resume under the other (`E_UNSUPPORTED_DEPLOYMENT`). Each deployment has its own payment token, so `mm ensv2 faucet --deployment hackathon` mints a *different* test USDC from the beta's.

`--chain` is unchanged: 11155111 or a refusal. Mainnet stays disabled until a canonical production deployment exists.

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
--deployment <beta|hackathon>   which pinned Sepolia deployment to talk to (default beta; env MM_ENSV2_DEPLOYMENT)
--chain <id>                    EVM chain id (default 11155111; anything else is refused)
--json                          machine-readable output
```

On `jobs show` and `jobs abandon` the flag is validated but has no effect — those are addressed by job id, and the job's own deployment is what they report. `jobs list` lists both deployments unless you name one.

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

The gate is **generation-aware**: which reads it performs is decided by the selected deployment's generation, and a table of one generation can never be accepted against the other's contracts.

On `beta` (g1) it performs five reads and reports each one:

1. `UniversalResolver.supportsInterface(IUniversalResolverV2 = 0xf99a5e06)` is true
2. `UniversalResolver.findCanonicalRegistry("eth")` equals the configured `.eth` registry
3. `RootRegistry.getSubregistry("eth")` points at that registry (forward)
4. that registry's `getParent()` points back at the root with label `eth` (backward)
5. `VerifiableFactory.proxyLogic()` matches the configured proxy logic, so CREATE2 resolver prediction is sound

On `hackathon` (g2) it performs seven, because two things moved:

1. `UniversalResolver.supportsInterface(IUniversalResolverV2 = 0x1a6cc9f0)` is true — a different id on this generation
2. `UniversalResolver.supportsInterface(0xf99a5e06)` is **false** — the explicit refusal to cross-accept a g1 deployment
3. `UniversalHelper.findCanonicalRegistry("eth")` equals the configured `.eth` registry — the UR reverts on this call here
4. `RootRegistry.getSubregistry("eth")` points at that registry (forward)
5. that registry's `getParent()` points back at the root with label `eth` (backward)
6. `VerifiableFactory.proxyLogic()` matches the configured proxy logic
7. `UniversalResolver.findResolver("eth")` is callable — resolution itself stayed on the UR, and every read goes through it

Check 1 of each list is what makes the two un-crossable: on chain the beta UR answers `false` to the g2 id and reverts on `isENSv2()`, and the hackathon UR answers `false` to the g1 id.

### Why `resolver deploy` exists

ENSv2 replaces the single shared Public Resolver with **one `PermissionedResolver` proxy per account**. A freshly registered name has no resolver, resolves to nothing, and can hold no records until one is deployed and assigned. `deploy` provisions it through the `VerifiableFactory`: it predicts the CREATE2 address (salt derived from the wallet address, `proxyLogic` read from chain), no-ops if code already exists there, builds the `deployProxy(...)` calldata with the initializer that deployment's implementation actually exposes — the three-argument `initialize(admin, ALL_ROLES, [])` on `beta`, and `initialize([{admin, roles}], [])` on `hackathon`, where `roles` is composed from `PermissionedResolverLib`'s named constants rather than a blanket literal — hands `{to, data, value: 0}` to the wallet executor, waits for the receipt, then re-reads the chain and requires the factory to attest the proxy. The plugin never sees a key.

Run `plan` first to see the address and the exact calldata. Deploying costs only gas.

### How `register` works

Three transactions, each signed through MetaMask policy (MFA if enabled), each verified on chain before the next:

1. `commit(makeCommitment(label, owner, secret, 0, resolver, duration, 0))` — the wallet's resolver is bound into the commitment, so `resolver deploy` must have run first. The secret and parameters are checkpointed to `~/.mm-plugin-ensv2/pending-registrations.json` (mode 0600) **before** this is sent.
2. `USDC.approve(registrar, total)` — only if the allowance is short; done during the commitment wait.
3. after chain time ≥ commit + 60 s: `register(...)` — pays the registrar, mints the name, sets the resolver in one call.

Then it checks the registry says `REGISTERED` to you and `UR.findResolver` returns your resolver at offset 0, and clears the checkpoint. Re-running after an interruption resumes with the same secret and commitment; an expired commitment (> 24 h) is re-committed. Price is quoted by the registrar (non-linear over duration; 28-day minimum) and paid in the oracle's ERC-20 — on Sepolia, `mm ensv2 faucet` mints it.

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

For `beta`: the official ENS deployment table, the checked-in Sepolia deployment artifacts in `ensdomains/contracts-v2`, and `ensdomains/ens-cli`, all cross-checked and verified live.

For `hackathon`: the [ENS deployments page](https://feature-permres-inode-refact.docs-bao.pages.dev/learn/deployments#sepolia-ensv2-beta) section *Sepolia (ENSv2 Beta) – ETHOnline 2026 Hackathon Deployment*, row for row, with every derived value re-checked on chain. The matching contract source is the ENS contracts repo's `contracts/src/` — the newer generation — not its `deployments/sepolia` artifacts, which describe `beta`.

Neither table is trusted blindly: `status` re-derives the registry from chain and refuses if the table disagrees; the resolver factory's clone target, the adapter implementation (EIP-1967 slot) and the reverse registrar (root → reverse TLD resolver → v1 registry) are each re-derived on use. Full generated table, both deployments: https://mm-ensv2.estmcmxci.co/reference/deployment.

## Design notes

- Detection is ported from `ensdomains/ens-cli` (`src/lib/context.ts`) with its fail-open default inverted.
- The probe is `supportsInterface(0xf99a5e06)`, not `isENSv2()` — the latter is declared in some copies of the contracts source but does not exist on the deployed Universal Resolver.
- The host-provided `ctx.publicClient(chainId)` carries no `chain` object; every read passes an explicit address.
- Signing never happens in the plugin. Write commands build calldata and hand it to `ctx.walletExecutor()`.
- The job engine (`src/lib/provision.ts`) imports nothing from the host: it reads through `ProvisionChain` and sends through `Submit`, so the interruption matrix runs against an in-memory chain that applies the engine's real calldata (`test/mock-chain.mjs`), and `scripts/check.mjs provision-plan` runs the planner against public Sepolia.
- The schemas under `schemas/` are consumed, never edited (D-011 additive-only freeze). `src/lib/schema.ts` is a small draft 2020-12 validator covering exactly the keywords they use; `test/schema.test.mjs` requires the same answers as the program's ajv runner on all 75 vendored fixtures.

## License

MIT. Built by 𝔪✶ [Émile Marcel Agustín](https://estmcmxci.co).
