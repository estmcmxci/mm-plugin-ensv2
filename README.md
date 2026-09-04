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
mm ensv2 primary get [address]      the address's primary name: raw reverse record, forward check, UR round-trip
mm ensv2 primary set <name>         make <name> this wallet's primary name (one tx; name must already resolve to you)
mm ensv2 resolver plan       predict THIS WALLET's resolver address + show the deploy calldata (read-only)
mm ensv2 resolver deploy     deploy this wallet's resolver, once (no-op if it exists) — signs via MetaMask policy
mm ensv2 provision <name> --agent-uri <uri> [...]   resolver → register → ERC-8004 bind → records as ONE resumable job
mm ensv2 jobs list [--all]          the provisioning jobs on this machine
mm ensv2 jobs show <jobId>          a job's intent, record, step receipts and errors (secret redacted)
mm ensv2 jobs resume <jobId>        continue a job; re-derives every step from chain, never repeats a paid step
```

### Why `resolver deploy` exists

ENSv2 replaces the single shared Public Resolver with **one `PermissionedResolver` proxy per account**. A freshly registered name has no resolver, resolves to nothing, and can hold no records until one is deployed and assigned. `deploy` provisions it through the `VerifiableFactory`: it predicts the CREATE2 address (salt derived from the wallet address, `proxyLogic` read from chain), no-ops if code already exists there, builds the `deployProxy(...)` calldata with the three-argument `initialize(admin, ALL_ROLES, [])`, hands `{to, data, value: 0}` to the wallet executor, waits for the receipt, then re-reads the chain and requires the factory to attest the proxy. The plugin never sees a key.

Run `plan` first to see the address and the exact calldata. Deploying costs only gas.

### How `register` works

Three transactions, each signed through MetaMask policy (MFA if enabled), each verified on chain before the next:

1. `commit(makeCommitment(label, owner, secret, 0, resolver, duration, 0))` — the wallet's resolver is bound into the commitment, so `resolver deploy` must have run first. The secret and parameters are written to the job file (see *Durable jobs* below) **before** this is sent.
2. `USDC.approve(registrar, ceiling)` — only if the allowance is short; done during the commitment wait.
3. after chain time ≥ commit + 60 s, and after re-reading the price against the job's spend ceiling: `register(...)` — pays the registrar, mints the name, sets the resolver in one call.

Then it checks the registry says `REGISTERED` to you and `UR.findResolver` returns your resolver at offset 0, and verifies the result through two independent RPC endpoints. Re-running after an interruption resumes the same job with the same secret and commitment; an expired commitment (> 24 h) is re-committed once. Price is quoted by the registrar (non-linear over duration; 28-day minimum) and paid in the oracle's ERC-20 — on Sepolia, `mm ensv2 faucet` mints it.

Since 0.7.0 `register` is the registration-only form of `provision` and runs through the same job engine. A checkpoint left by an earlier version in `~/.mm-plugin-ensv2/pending-registrations.json` is adopted into the new job on the next `register` for that label (its secret and commitment are kept, nothing is re-committed) and then removed.

### Durable jobs: `provision` and `jobs`

`provision` runs the whole ladder — resolver deploy, commit, approve, wait, register, ERC-8004 bind through Adapter8004, and the record set (addr, description, url, `agent-endpoint[…]`, `agent-context`, and the ENSIP-25 link) — as **one job** that survives the process dying at any point.

```bash
mm ensv2 provision myagent --agent-uri https://agent.example/agent.json \
  --description "My agent" --endpoints web=https://agent.example
mm ensv2 provision myagent --no-identity            # name + records only, no ERC-8004
mm ensv2 provision myagent --agent-uri ... --dry-run  # intent + plan + what each step sees on chain; nothing written or sent
```

**What a job is.** A file at `~/.mm-plugin-ensv2/jobs/<jobId>.json` (mode 0600) holding three things: the *provisioning intent* (the program's `provisioning-intent` 1.0.0 object for the direct-custody path, with its EIP-712 digest computed but not signed), the *job record* (`provisioning-job` 1.0.0: state, facts, an ordered step list, and a `step-receipt` for every transaction), and a *private* section with the commit/reveal tuple and its secret. Every write is validated against the frozen schemas vendored under `schemas/` (see `schemas/PROVENANCE.md`); the secret is never in the record, only a `commitmentSecretRef` handle, and `jobs show` redacts it. The final verification is a `verification-result` 1.0.0 computed from two independent RPC endpoints (`--verify-rpc`, `MM_ENSV2_VERIFY_RPC`, default publicnode); a single endpoint cannot produce a `verified` outcome.

**The job id is deterministic.** It derives from (chain, name, owner, intent hash), so running the same `provision` again does not start a second job — it finds the existing one and resumes it. If a job for the name already exists with *different* inputs (another duration, other records, a different agent URI) the command refuses with `E_IDEMPOTENCY_CONFLICT` and tells you which job to `jobs resume` or inspect, rather than committing or paying twice.

**Resume re-derives everything from chain first.** Every step observes before it acts: does code exist at the predicted resolver address and does the factory attest it; is the commitment on chain and how old is it; does the allowance cover the ceiling; does the registry say the name is `REGISTERED` to you; is an agent already bound to the name's current token (`AgentBound` scan + `bindingOf`); do the records already read back through the Universal Resolver. A step the chain shows done is skipped, whatever the job file says. That is what makes a crash after any transaction landed harmless — the next run finds the effect and moves on — and it is also why a re-run is a no-op for a completed job.

**A paid or irreversible step is never re-sent when its outcome is unknown.** If the job file says a step was submitted but the chain shows no effect — the process died between sending and confirming, or the wallet reported a network error after the request went out — the job **halts** with an `indeterminate` error (`E_RECEIPT_UNAVAILABLE`, or `E_IDENTITY_BINDING_FAILED` for the bind) that says exactly what to check: the transaction hash if one was recorded, `mm wallet requests list` for a pending approval, `whois`/`agent info`/`records get` for the effect. If the transaction is merely pending, wait and run the job again; it will be found on chain and skipped. Only when you have confirmed nothing landed and nothing is pending, run `mm ensv2 jobs resume <jobId> --resubmit-unconfirmed` to send it once more. A confirmed revert (receipt read, status reverted) marks the step retryable, and the **next** run retries it once — no step is ever retried twice within one run, and identity always re-enters at preflight (re-reads the current token id and the adapter implementation) before a bind. An agent whose binding was orphaned by a role change is terminal for the job: it will not mint a second agent on its own.

```bash
mm ensv2 jobs list                 # jobs that can still run; --all for completed/terminal too
mm ensv2 jobs show <jobId>         # intent, record, receipts, errors; private secret redacted
mm ensv2 jobs resume <jobId>       # same as re-running provision with the original arguments
```

Every error the engine raises is one of the program's `errors` 1.0.0 codes, and the command's error code is that code; the hint is the schema's `recoveryAction`. A job's `resume` block records whether it is resumable, from which step, and what blocks it.

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
- The job engine (`src/lib/provision.ts`) imports nothing from the host: it reads through `ProvisionChain` and sends through `Submit`, so the interruption matrix runs against an in-memory chain that applies the engine's real calldata (`test/mock-chain.mjs`), and `scripts/check.mjs provision-plan` runs the planner against public Sepolia.
- The schemas under `schemas/` are consumed, never edited (D-011 additive-only freeze). `src/lib/schema.ts` is a small draft 2020-12 validator covering exactly the keywords they use; `test/schema.test.mjs` requires the same answers as the program's ajv runner on all 75 vendored fixtures.
