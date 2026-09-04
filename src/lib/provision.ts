/**
 * The durable provisioning job engine (v0.6).
 *
 * One job runs resolver deploy → commit → approve → wait → register → agent
 * bind → records, writing a step receipt after every step to a job file that
 * follows provisioning-job 1.0.0. The engine is pure with respect to its
 * environment: every chain read goes through ProvisionChain, every wallet
 * submission through Submit, every persist through JobStore. The plugin
 * commands wire the host's client, executor and ~/.mm-plugin-ensv2/jobs; the
 * interruption tests wire an in-memory chain and a killable executor.
 *
 * The two rules everything below serves:
 *
 *  1. Completion state is RE-DERIVED FROM CHAIN before anything is sent. Each
 *     step first observes (resolver code + factory attestation; commitmentAt;
 *     allowance; registry ownership; AgentBound + bindingOf; records through
 *     the Universal Resolver) and only acts when the chain says the work is
 *     not done. A run that died after a transaction landed but before the
 *     record was updated therefore resumes by skipping, never by resending.
 *
 *  2. A step that was SUBMITTED BUT WHOSE OUTCOME CANNOT BE ESTABLISHED halts.
 *     If a step is recorded in_progress and the chain shows no evidence of it,
 *     the job stops with an indeterminate error that says exactly what to
 *     check. Nothing paid or irreversible is ever resent automatically; the
 *     user re-runs after inspection, or passes --resubmit-unconfirmed after
 *     confirming nothing landed. A confirmed revert (receipt read, status
 *     reverted) marks the step failed/retryable and the NEXT run retries it;
 *     no step is retried twice within one run. Identity resumption always
 *     re-enters at identity_preflight (D-010).
 */
import { getAddress, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { labelhash, namehash } from "viem/ens";
import { TOKEN_STANDARD, adapter8004Abi } from "./abis.js";
import { agentIdFromReceipt } from "./agent.js";
import type { ProvisionChain, ReceiptLite } from "./chain.js";
import type { EnsV2Deployment } from "./deployments.js";
import { ensip25Key } from "./erc7930.js";
import { buildIntent, intentIsConsistent, jobIdFor, type BuildIntentInput, type IntentRecord, type ProvisioningIntent } from "./intent.js";
import {
  JOB_FILE_FORMAT,
  TERMINAL_STATES,
  commitmentSecretRef,
  findStep,
  nowIso,
  programError,
  transactionHashes,
  upsertStep,
  type JobFile,
  type JobRecord,
  type JobState,
  type JobStore,
  type PrivateCommitment,
  type ProgramError,
  type ReceiptStepName,
  type StepName,
  type TransactionReceiptRecord,
  type VerificationCheck,
  type VerificationResult,
} from "./jobs.js";
import { ethLabel } from "./names.js";
import { ReadError, type WhoisInfo } from "./reads.js";
import { buildRecordsMulticall, diffRecords, type DesiredRecords } from "./records.js";
import { ZERO_ADDRESS, ZERO_REFERRER, buildApprove, buildCommit, buildRegister, makeSecret, type Calldata, type CommitmentParams } from "./registrar.js";
import { buildDeployPlan } from "./resolver.js";
import { encodeFunctionData } from "viem";

// ---------------------------------------------------------------------------
// Dependencies

export type SubmitRequest = { step: ReceiptStepName; calldata: Calldata; summary: string; details: Record<string, string> };
export type SubmitResult = { hash?: Hex; status: string; failureCode?: string; failureDescription?: string; walletJobId?: string };
/** Hands unsigned calldata to the wallet. In the plugin this wraps ctx.walletExecutor; it never sees a key. */
export type Submit = (req: SubmitRequest) => Promise<SubmitResult>;

export type EngineDeps = {
  chain: ProvisionChain;
  /** Second, independent endpoint consulted by the final verification (verification-result requires two). */
  verifyChain: ProvisionChain;
  deployment: EnsV2Deployment;
  submit: Submit;
  store: JobStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  progress?: (msg?: string) => void;
  signal?: AbortSignal;
};

export type RunOptions = {
  /** The user has confirmed that a step recorded as submitted never landed and is not pending. Lets the engine send it again. */
  resubmitUnconfirmed?: boolean;
};

/** Thrown by the engine when a job halts. `error` is a schema-valid program error; the job file has already been persisted. */
export class ProvisionHalt extends Error {
  constructor(
    readonly error: ProgramError,
    readonly file: JobFile,
  ) {
    super(error.message);
    this.name = "ProvisionHalt";
  }
}

class Halt extends Error {
  constructor(
    readonly err: Omit<ProgramError, "occurredAt">,
    readonly state: JobState,
    readonly resumeFrom?: Exclude<StepName, "identity_bind">,
    readonly notBefore?: string,
  ) {
    super(err.message);
  }
}

// ---------------------------------------------------------------------------
// Requests and planning

export type ProvisionRequest = {
  /** Raw user input; the label is derived from it. */
  input: string;
  owner: Address;
  durationSeconds: bigint;
  /** null = identity none. */
  identity: { agentUri: string } | null;
  /** Records committed by the intent. addr null = do not set. Text keys already validated by the caller. */
  records: { addr: Address | null; texts: Record<string, string> };
  /** provision: deploy-owned (deploy if missing). register: reuse-existing (must already exist). */
  resolverMode: "deploy-owned" | "reuse-existing";
  /** Explicit spend ceiling in payment-token units; default is the live quote. */
  maxSpend?: bigint;
};

/** The parts of an intent a user controls; two requests with equal inputs are the same job. */
export function userInputsOf(i: ProvisioningIntent): string {
  return JSON.stringify({
    name: i.name.normalized,
    owner: i.owner.toLowerCase(),
    duration: i.durationSeconds,
    resolver: { mode: i.resolverConfig.mode, address: i.resolverConfig.address.toLowerCase() },
    records: i.resolverConfig.records,
    identity: i.identityConfig ? { agentUri: i.identityConfig.agentUri } : null,
  });
}

export type Plan =
  | { kind: "existing"; file: JobFile; inputsMatch: boolean; conflict?: ProgramError }
  | { kind: "new"; file: JobFile; quoteTotal: bigint; alreadyRegistered: boolean };

/** Find jobs for (chain, name, owner). Non-terminal first, newest first. */
export async function jobsFor(store: JobStore, chainId: number, normalizedName: string, owner: Address): Promise<JobFile[]> {
  const all = await store.list();
  return all
    .filter((f) => f.job.chain === `eip155:${chainId}` && f.job.facts.normalizedName === normalizedName && isAddressEqual(f.job.facts.owner, owner))
    .sort((a, b) => {
      const ta = TERMINAL_STATES.has(a.job.state) ? 1 : 0;
      const tb = TERMINAL_STATES.has(b.job.state) ? 1 : 0;
      return ta - tb || b.job.updatedAt.localeCompare(a.job.updatedAt);
    });
}

function halt(err: Omit<ProgramError, "occurredAt">, state: JobState = "retryable_failed", resumeFrom?: Exclude<StepName, "identity_bind">, notBefore?: string): never {
  throw new Halt(err, state, resumeFrom, notBefore);
}

const iso = (unix: number) => nowIso(new Date(unix * 1000));

/**
 * Plan a provisioning run without touching the wallet or the store. Returns
 * either the existing job for these inputs (resume / no-op / conflict) or a
 * fully formed, unsaved new job.
 */
export async function planProvision(deps: Pick<EngineDeps, "chain" | "deployment" | "store" | "now" | "log">, req: ProvisionRequest): Promise<Plan> {
  const d = deps.deployment;
  const chainId = d.chainId;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const owner = getAddress(req.owner);

  let label: string;
  try {
    label = ethLabel(req.input);
  } catch (e) {
    halt({ code: "E_NAME_INVALID", category: "validation", retryability: "terminal", message: e instanceof Error ? e.message : String(e), recoveryAction: { kind: "none", description: "Pass a registrable <label>.eth name of at least 3 characters." } }, "terminal_failed");
  }
  const normalized = `${label}.eth`;

  // 1. Is there already a job for (chain, name, owner)?
  const existing = await jobsFor(deps.store, chainId, normalized, owner);

  // 2. Facts every intent needs, all deterministic in the inputs.
  const res = await deps.chain.resolverStatus(owner);
  if (req.resolverMode === "reuse-existing" && (!res.deployed || res.verified !== true)) {
    halt(
      {
        code: "E_RESOLVER_NOT_PREPARED",
        category: "ens",
        retryability: "requires_user_action",
        message: `This wallet has no verified ENSv2 resolver yet (would be ${res.predicted}); the resolver address is bound into the registration commitment.`,
        recoveryAction: { kind: "manual_intervention", description: "Run `mm ensv2 resolver deploy` first, or use `mm ensv2 provision`, which deploys it as the first step of the job." },
      },
      "terminal_failed",
    );
  }
  if (!res.proxyLogicMatchesConfig) {
    halt({ code: "E_DEPLOYMENT_DRIFT", category: "deployment", retryability: "terminal", message: `VerifiableFactory.proxyLogic() is ${res.proxyLogic}, configured ${d.resolverProxyLogic}; the predicted resolver address would be wrong.`, recoveryAction: { kind: "abandon_job", description: "Do not transact against a factory the deployment table disagrees with. Update the deployment table." } }, "terminal_failed");
  }

  const records: IntentRecord[] = [];
  if (req.records.addr) records.push({ kind: "addr", key: "60", value: getAddress(req.records.addr) });
  for (const [key, value] of Object.entries(req.records.texts)) records.push({ kind: "text", key, value });

  let identity: BuildIntentInput["identity"] = null;
  if (req.identity) {
    if (!/^(https?:\/\/|ipfs:\/\/)\S+$/i.test(req.identity.agentUri)) {
      halt({ code: "E_NAME_INVALID", category: "validation", retryability: "terminal", message: `'${req.identity.agentUri}' is not an http(s):// or ipfs:// agentURI.`, recoveryAction: { kind: "none", description: "Pass --agent-uri with the URI of the agent's ERC-8004 registration JSON, or --no-identity." } }, "terminal_failed");
    }
    const impl = await deps.chain.adapterImplementation();
    if (isAddressEqual(impl, zeroAddress)) {
      halt({ code: "E_IDENTITY_ADAPTER_UNAVAILABLE", category: "identity", retryability: "requires_user_action", message: `Adapter8004 at ${d.adapter8004} reports no EIP-1967 implementation.`, recoveryAction: { kind: "manual_intervention", description: "Check the adapter deployment, or run with --no-identity." } }, "terminal_failed");
    }
    identity = { adapterProxy: d.adapter8004, adapterImplementation: impl, erc8004Registry: d.identityRegistry, agentUri: req.identity.agentUri, controllerAddress: owner };
  }

  // 3. Registration economics: quote if available; zero if the name is already ours.
  const avail = await deps.chain.available(label);
  if (Number(req.durationSeconds) < avail.minRegisterDuration) {
    halt({ code: "E_DURATION_OUT_OF_BOUNDS", category: "validation", retryability: "terminal", message: `Duration ${req.durationSeconds}s is below the registrar minimum of ${avail.minRegisterDuration}s (${avail.minRegisterDuration / 86400} days).`, recoveryAction: { kind: "none", description: "Pass a longer --years (0.08 ≈ 28 days)." } }, "terminal_failed");
  }
  let quoteTotal = 0n;
  let alreadyRegistered = false;
  if (avail.available) {
    const q = await deps.chain.quote(label, req.durationSeconds);
    quoteTotal = BigInt(q.total);
  } else {
    const w = await deps.chain.whois(normalized);
    if (w.status === "REGISTERED" && w.owner && isAddressEqual(w.owner, owner)) {
      alreadyRegistered = true;
      log("info", `${normalized} is already registered to this wallet; the registration steps will be observed as done.`);
    } else {
      halt({ code: "E_NAME_UNAVAILABLE", category: "ens", retryability: "terminal", message: `${normalized} is not available to register (${w.status}${w.owner ? `, owned by ${w.owner}` : ""}).`, recoveryAction: { kind: "abandon_job", description: "Registered by someone else, in its grace period, or reserved from ENSv1 pre-migration. Check `mm ensv2 whois`." } }, "terminal_failed");
    }
  }
  const maxSpend = req.maxSpend ?? quoteTotal;
  if (maxSpend < quoteTotal) {
    halt({ code: "E_PRICE_EXCEEDS_MAX_SPEND", category: "funding", retryability: "requires_user_action", message: `The registrar quotes ${quoteTotal} token units; --max-spend allows ${maxSpend}.`, recoveryAction: { kind: "refresh_quote_and_resume", description: "Raise --max-spend to at least the quoted total, or omit it to accept the quote." } }, "terminal_failed");
  }

  const intent = buildIntent({
    chainId,
    deploymentId: d.deploymentId,
    input: req.input,
    label,
    owner,
    durationSeconds: Number(req.durationSeconds),
    resolver: { mode: req.resolverMode, address: res.predicted, initializeForwardAddress: !!req.records.addr },
    records,
    identity,
    maxSpend: { asset: d.paymentToken, maxTotalAmount: maxSpend },
  });

  // 4. Existing job: resume it, or refuse to start a second one for different inputs.
  if (existing.length) {
    const file = existing[0]!;
    const inputsMatch = userInputsOf(file.intent) === userInputsOf(intent);
    if (inputsMatch) return { kind: "existing", file, inputsMatch: true };
    const conflict = programError({
      code: "E_IDEMPOTENCY_CONFLICT",
      category: "validation",
      retryability: "requires_user_action",
      message: `Job ${file.job.jobId} already exists for ${normalized} (state ${file.job.state}) with different inputs; refusing to start a second job that could commit or pay again.`,
      recoveryAction: { kind: "inspect_job_status", description: `Run \`mm ensv2 jobs show ${file.job.jobId}\`; resume it with \`mm ensv2 jobs resume ${file.job.jobId}\` or the original arguments. To change records on a completed name use \`mm ensv2 records set\`.` },
      evidence: { jobId: file.job.jobId, intentHash: file.job.intentHash, deploymentId: d.deploymentId },
    });
    return { kind: "existing", file, inputsMatch: false, conflict };
  }

  // 5. Funding preflight for a brand-new job. Nothing durable exists yet, so refuse rather than record a blocked job.
  if (!alreadyRegistered && quoteTotal > 0n) {
    const { balance } = await deps.chain.tokenState(owner);
    if (balance < quoteTotal) {
      halt({ code: "E_INSUFFICIENT_FUNDS", category: "funding", retryability: "requires_user_action", message: `Registering ${normalized} costs ${quoteTotal} token units; this wallet holds ${balance}.`, recoveryAction: { kind: "fund_wallet_and_resume", description: "On Sepolia, run `mm ensv2 faucet` to mint test USDC, then run the same command again." } }, "terminal_failed");
    }
  }

  // 6. The job. The commitment tuple is fixed now so the commitment hash is durable before anything is sent.
  const jobId = jobIdFor(chainId, normalized, owner, intent.eip712.intentHash);
  const commitment: PrivateCommitment = {
    label,
    owner,
    secret: makeSecret(),
    subregistry: ZERO_ADDRESS,
    resolver: res.predicted,
    durationSeconds: Number(req.durationSeconds),
    referrer: ZERO_REFERRER,
    commitment: "0x" as Hex, // filled below
  };
  commitment.commitment = await deps.chain.computeCommitment({ ...commitment, durationSeconds: req.durationSeconds });
  const t = nowIso(now());
  const job: JobRecord = {
    schemaVersion: "1.0.0",
    jobId,
    origin: "local",
    state: "direct_funding_ready",
    intentHash: intent.eip712.intentHash,
    idempotencyKey: intent.idempotencyKey,
    deploymentId: d.deploymentId,
    chain: `eip155:${chainId}`,
    payment: "direct",
    identity: intent.identity,
    custodyMode: "direct",
    createdAt: t,
    updatedAt: t,
    facts: {
      normalizedName: normalized,
      labelhash: labelhash(label),
      owner,
      durationSeconds: Number(req.durationSeconds),
      commitmentSecretRef: commitmentSecretRef(jobId),
      commitmentHash: commitment.commitment,
      resolverAddress: res.predicted,
      attemptCounters: {},
    },
    steps: [
      { step: "name_validate", state: "succeeded", attempts: 1, completedAt: t },
      { step: "quote", state: alreadyRegistered ? "skipped" : "succeeded", attempts: 1, completedAt: t },
      { step: "funding_preflight", state: alreadyRegistered || quoteTotal === 0n ? "skipped" : "succeeded", attempts: 1, completedAt: t },
    ],
    outcome: { ens: "pending", identity: intent.identity === "erc8004" ? "pending" : "not_requested", payment: "not_required" },
    resume: { resumable: true, resumeFromStep: "canonicality_check", nextAction: "Run the job.", requiresPayment: !alreadyRegistered },
  };
  const file: JobFile = { format: JOB_FILE_FORMAT, intent, job, private: { commitment } };
  return { kind: "new", file, quoteTotal, alreadyRegistered };
}

/** Import a v0.3 pending-registrations.json checkpoint into an unsaved new job, so an in-flight commitment keeps its secret. */
export function adoptLegacyCommitment(file: JobFile, legacy: { secret: Hex; commitment: Hex; owner: Address; resolver: Address; durationSeconds: number; subregistry: Address; referrer: Hex }): boolean {
  const c = file.private.commitment;
  if (!c) return false;
  if (!isAddressEqual(legacy.owner, c.owner) || !isAddressEqual(legacy.resolver, c.resolver) || legacy.durationSeconds !== c.durationSeconds) return false;
  file.private.commitment = { ...c, secret: legacy.secret, commitment: legacy.commitment, subregistry: legacy.subregistry, referrer: legacy.referrer };
  file.job.facts.commitmentHash = legacy.commitment;
  return true;
}

// ---------------------------------------------------------------------------
// Steps

export const STEP_ORDER: readonly StepName[] = [
  "canonicality_check",
  "resolver_deploy",
  "commitment_submit",
  "payment_token_approve",
  "commitment_wait",
  "price_recheck",
  "registration_submit",
  "identity_preflight",
  "identity_bind",
  "identity_verify",
  "records_configure",
  "ens_verify",
];

/** Which steps this job's intent calls for. */
export function stepsFor(intent: ProvisioningIntent): StepName[] {
  return STEP_ORDER.filter((s) => {
    if (s === "resolver_deploy") return intent.resolverConfig.mode === "deploy-owned";
    if (s === "identity_preflight" || s === "identity_bind" || s === "identity_verify") return intent.identity === "erc8004";
    if (s === "records_configure") return intent.resolverConfig.records.length > 0 || intent.identity === "erc8004";
    return true;
  });
}

/**
 * What the chain says about a step. `settled` marks the one case where the
 * effect is absent but a previous submission's outcome is nevertheless KNOWN
 * (a commitment that landed and then expired): re-running the step is then
 * not a blind retry.
 */
type Observation = { done: boolean; detail: string; settled?: boolean };

const STATE_ORDER: readonly JobState[] = ["direct_funding_ready", "accepted", "resolver_prepared", "commitment_submitted", "commitment_confirmed", "commitment_maturing", "registration_submitted", "ens_registered", "identity_pending", "identity_bound", "completed"];

type TxSpec = {
  /** What a duplicate submission would do, for the halt message. */
  duplicate: string;
  /** What the user should check before overriding. */
  inspect: string;
  observe: () => Promise<Observation>;
  build: () => Promise<{ calldata: Calldata; summary: string; details: Record<string, string> }>;
  /** After a success receipt: the chain must show the effect. Throw a Halt otherwise. */
  confirm: (receipt: ReceiptLite) => Promise<void>;
  /** Error code for an indeterminate outcome on this step. */
  indeterminateCode?: ProgramError["code"];
  /** Error code for a confirmed revert on this step. */
  revertCode?: ProgramError["code"];
  /** Where the next run re-enters after a failure on this step. */
  resumeFrom: Exclude<StepName, "identity_bind">;
};

class Runtime {
  readonly d: EnsV2Deployment;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: NonNullable<EngineDeps["log"]>;
  readonly progress: NonNullable<EngineDeps["progress"]>;
  /** Cleared when a step is found to be blocked; the run stops there. */
  discoveredAgentId: bigint | null = null;

  constructor(
    readonly deps: EngineDeps,
    readonly file: JobFile,
    readonly opts: RunOptions,
  ) {
    this.d = deps.deployment;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? (() => {});
    this.progress = deps.progress ?? (() => {});
  }

  get job(): JobRecord {
    return this.file.job;
  }
  get intent(): ProvisioningIntent {
    return this.file.intent;
  }
  get name(): string {
    return this.job.facts.normalizedName;
  }
  get owner(): Address {
    return this.job.facts.owner;
  }
  get commitment(): PrivateCommitment {
    const c = this.file.private.commitment;
    if (!c) {
      halt({ code: "E_COMMITMENT_SECRET_UNAVAILABLE", category: "ens", retryability: "terminal", message: "The job file carries no commitment tuple; the registration cannot be completed with it.", recoveryAction: { kind: "abandon_job", description: "Wait for any live commitment to expire (24 h), delete the job file, and start again." } }, "terminal_failed");
    }
    return c;
  }
  get commitmentParams(): CommitmentParams {
    const c = this.commitment;
    return { label: c.label, owner: c.owner, secret: c.secret, subregistry: c.subregistry, resolver: c.resolver, durationSeconds: BigInt(c.durationSeconds), referrer: c.referrer };
  }

  ts(): string {
    return nowIso(this.now());
  }

  /** Recompute the derived blocks and persist. Validation happens in the store. */
  async save(): Promise<void> {
    const job = this.job;
    job.updatedAt = this.ts();
    const registered = job.outcome?.ens === "succeeded";
    if (job.state === "completed") {
      job.resume = { resumable: false, nextAction: "none", requiresPayment: false };
    } else if (!job.resume?.blockedBy) {
      const next = stepsFor(this.intent).find((s) => findStep(job, s)?.state !== "succeeded" && findStep(job, s)?.state !== "skipped");
      const from = next === "identity_bind" ? "identity_preflight" : next;
      job.resume = { ...(job.resume ?? { resumable: true }), resumable: true, ...(from ? { resumeFromStep: from } : {}), nextAction: from ? `Resume at ${from}.` : "Run the final verification.", requiresPayment: !registered };
    }
    await this.deps.store.put(this.file);
  }

  setState(state: JobState): void {
    this.job.state = state;
  }

  /** Move the progress state forward only; re-observing an early step on a later run never regresses it. */
  advance(state: JobState): void {
    const cur = STATE_ORDER.indexOf(this.job.state);
    const next = STATE_ORDER.indexOf(state);
    if (next > cur) this.job.state = state;
  }

  async markStep(name: StepName, state: "succeeded" | "skipped", detail?: string): Promise<void> {
    const s = upsertStep(this.job, name, { state, completedAt: this.ts() });
    if (state === "succeeded" && !s.attempts) s.attempts = 1;
    delete s.error;
    if (detail) this.log("info", `${name}: ${detail}`);
    await this.save();
  }

  /** Persist a halt onto the step and the job, then throw ProvisionHalt. */
  async fail(name: StepName, h: Halt): Promise<never> {
    const err = programError({ ...h.err, step: name, occurredAt: this.ts(), evidence: { ...(h.err.evidence ?? {}), jobId: this.job.jobId, intentHash: this.job.intentHash, deploymentId: this.d.deploymentId } });
    const s = upsertStep(this.job, name, {});
    if (s.state !== "in_progress") s.state = "failed";
    s.error = err;
    this.setState(h.state);
    const registered = this.job.outcome?.ens === "succeeded";
    this.job.resume = {
      resumable: h.state !== "terminal_failed",
      ...(h.state !== "terminal_failed" ? { resumeFromStep: h.resumeFrom ?? (name === "identity_bind" ? "identity_preflight" : (name as Exclude<StepName, "identity_bind">)) } : {}),
      nextAction: err.recoveryAction.description,
      blockedBy: err,
      ...(h.notBefore ? { notBefore: h.notBefore } : {}),
      requiresPayment: !registered && h.state !== "terminal_failed",
    };
    this.job.errors = [...(this.job.errors ?? []).slice(-9), err];
    await this.save();
    throw new ProvisionHalt(err, this.file);
  }

  // -- registration state, memoised per run (the chain moves; each step re-reads what it must) --

  async registeredToOwner(): Promise<{ registered: true; whois: WhoisInfo } | { registered: false; whois: WhoisInfo }> {
    const w = await this.deps.chain.whois(this.name);
    if (w.status === "REGISTERED" && w.owner && isAddressEqual(w.owner, this.owner)) return { registered: true, whois: w };
    if (w.status === "REGISTERED") {
      halt({ code: "E_NAME_UNAVAILABLE", category: "ens", retryability: "terminal", message: `${this.name} is registered to ${w.owner}, not this wallet.`, recoveryAction: { kind: "abandon_job", description: "The name was taken by someone else while this job was in flight. Nothing was paid by this job." } }, "terminal_failed");
    }
    return { registered: false, whois: w };
  }

  /**
   * Which agents this owner has bound to the name's token: the first still
   * bound to the CURRENT token id, and the first now orphaned by a later
   * token-id regeneration. Agents bound by other accounts are ignored.
   */
  async scanBindings(): Promise<{ bound: bigint | null; orphaned: bigint | null; scannedFrom: bigint; scannedTo: bigint }> {
    const scan = await this.deps.chain.findAgentIds(this.name);
    let bound: bigint | null = null;
    let orphaned: bigint | null = null;
    for (const id of scan.agentIds) {
      const by = scan.registeredBy[id.toString()];
      if (by && !isAddressEqual(by, this.owner)) continue;
      const info = await this.deps.chain.agentInfo(this.name, id);
      if (info.status === "bound" && bound === null) bound = id;
      else if (info.status === "orphaned" && orphaned === null) orphaned = id;
    }
    return { bound, orphaned, scannedFrom: scan.scannedFrom, scannedTo: scan.scannedTo };
  }

  orphanedHalt(agentId: bigint): never {
    halt(
      {
        code: "E_IDENTITY_BINDING_ORPHANED",
        category: "identity",
        retryability: "terminal",
        message: `Agent #${agentId} was bound to ${this.name}'s token, but the token id has since regenerated (a role grant or revoke); the binding is immutable and no unbind exists, so no address controls that agent through this name any more.`,
        source: "verifier",
        recoveryAction: { kind: "reregister_identity", description: "Mint a fresh agent against the current token with `mm ensv2 agent register <name> --uri <agentURI>`; this job will not mint a second agent on its own." },
        evidence: { transactionHashes: transactionHashes(this.job) },
      },
      "terminal_failed",
    );
  }

  /** Record the identity anchor the moment registration is observed complete (required by the job schema from then on). */
  recordRegistration(w: WhoisInfo): void {
    const tokenId = BigInt(w.tokenId).toString();
    this.job.facts.currentTokenId = tokenId;
    if (!this.job.facts.identityAnchor) this.job.facts.identityAnchor = { kind: "token-id", value: tokenId, observedAt: this.ts() };
    this.job.outcome = { ...(this.job.outcome ?? {}), ens: "succeeded", payment: "not_required" };
  }

  // -- the transaction-step protocol --

  async txStep(name: ReceiptStepName, spec: TxSpec): Promise<void> {
    try {
      await this.txStepInner(name, spec);
    } catch (e) {
      if (e instanceof Halt) await this.fail(name, e);
      throw e;
    }
  }

  private receiptRecord(name: ReceiptStepName, hash: Hex, attempt: number, walletJobId?: string): TransactionReceiptRecord {
    return { kind: "transaction", chain: `eip155:${this.d.chainId}`, deploymentId: this.d.deploymentId, step: name, transactionHash: hash, receiptStatus: "unknown", submittedAt: this.ts(), attempt, ...(walletJobId ? { walletJobId } : {}) };
  }

  private fillReceipt(rec: TransactionReceiptRecord, r: ReceiptLite): void {
    rec.receiptStatus = r.status;
    rec.blockNumber = Number(r.blockNumber);
    rec.blockHash = r.blockHash;
    rec.from = r.from;
    if (r.to) rec.to = r.to;
    rec.gasUsed = r.gasUsed.toString();
    rec.effectiveGasPrice = r.effectiveGasPrice.toString();
    rec.confirmedAt = this.ts();
  }

  private async readReceiptWithPatience(hash: Hex): Promise<ReceiptLite | null> {
    for (let i = 0; i < 6; i++) {
      const r = await this.deps.chain.receipt(hash);
      if (r) return r;
      await this.sleep(2000);
    }
    return null;
  }

  private indeterminate(name: ReceiptStepName, spec: TxSpec, message: string, hashes: Hex[] = []): never {
    halt(
      {
        code: spec.indeterminateCode ?? "E_RECEIPT_UNAVAILABLE",
        category: name === "identity_bind" ? "identity" : "network",
        retryability: "indeterminate",
        message,
        source: "wallet",
        recoveryAction: {
          kind: "inspect_job_status",
          description:
            `Do not resend. Check ${spec.inspect}. If the transaction is still pending, wait for it and run the job again: the engine will find it on chain and skip the step. ` +
            `Only if you have confirmed nothing landed and nothing is pending, run \`mm ensv2 jobs resume ${this.job.jobId} --resubmit-unconfirmed\`. A duplicate would ${spec.duplicate}.`,
        },
        ...(hashes.length ? { evidence: { transactionHashes: hashes } } : {}),
      },
      "retryable_failed",
      spec.resumeFrom,
    );
  }

  private revertHalt(name: ReceiptStepName, spec: TxSpec, hash: Hex): never {
    const code = spec.revertCode ?? "E_TRANSACTION_REVERTED";
    halt(
      {
        code,
        category: name === "identity_bind" ? "identity" : "ens",
        retryability: "retryable",
        message: `${name}: transaction ${hash} reverted (receipt read, status reverted). Nothing was paid or minted by it.`,
        source: "protocol",
        recoveryAction: { kind: name === "identity_bind" ? "resume_identity_only" : "resume_job", description: `Fix the cause and run the job again; the step will be re-attempted once${name === "identity_bind" ? ", after identity_preflight re-reads the current token id" : ""}.`, resumeFrom: spec.resumeFrom },
        evidence: { transactionHashes: [hash], revertConfirmed: true },
      },
      "retryable_failed",
      spec.resumeFrom,
    );
  }

  private async txStepInner(name: ReceiptStepName, spec: TxSpec): Promise<void> {
    const job = this.job;
    const step = findStep(job, name);

    // 1. A submission this job started but never recorded the outcome of.
    if (step?.state === "in_progress") {
      const pending = [...(step.receipts ?? [])].reverse().find((r) => r.receiptStatus === "unknown");
      if (pending) {
        const r = await this.deps.chain.receipt(pending.transactionHash);
        if (r) {
          this.fillReceipt(pending, r);
          await this.save();
          if (r.status === "reverted") {
            step.state = "failed";
            this.revertHalt(name, spec, pending.transactionHash);
          }
          await spec.confirm(r);
          const obs = await spec.observe();
          if (!obs.done) halt({ code: "E_VERIFICATION_MISMATCH", category: "ens", retryability: "retryable", message: `${name}: transaction ${pending.transactionHash} succeeded but the chain does not yet show its effect (${obs.detail}).`, recoveryAction: { kind: "resume_job", description: "Wait a block and run the job again.", resumeFrom: spec.resumeFrom } }, "retryable_failed", spec.resumeFrom);
          await this.markStep(name, "succeeded", `recovered from receipt ${pending.transactionHash}: ${obs.detail}`);
          return;
        }
        const obs = await spec.observe();
        if (obs.done) {
          this.log("warn", `${name}: receipt for ${pending.transactionHash} not found, but the chain shows the step done (${obs.detail}); treating it as complete.`);
          await this.markStep(name, "succeeded", obs.detail);
          return;
        }
        if (obs.settled) this.log("warn", `${name}: the previous submission's outcome is known (${obs.detail}); the step runs again.`);
        else if (!this.opts.resubmitUnconfirmed) this.indeterminate(name, spec, `${name}: transaction ${pending.transactionHash} was submitted but no receipt is available and the chain shows no effect yet (${obs.detail}).`, [pending.transactionHash]);
        // The receipt stays recorded as unknown: if that transaction lands later, a future run will still see it.
        else this.log("warn", `${name}: --resubmit-unconfirmed given; ${pending.transactionHash} is being treated as dropped.`);
      } else {
        const obs = await spec.observe();
        if (obs.done) {
          this.log("info", `${name}: found complete on chain after an interrupted submission (${obs.detail}); skipping.`);
          await this.markStep(name, "succeeded", obs.detail);
          return;
        }
        if (obs.settled) this.log("warn", `${name}: the previous submission's outcome is known (${obs.detail}); the step runs again.`);
        else if (!this.opts.resubmitUnconfirmed) this.indeterminate(name, spec, `${name} was submitted by a previous run (attempt ${step.attempts ?? 1}, started ${step.startedAt ?? "unknown"}) but its outcome was never recorded and the chain shows no effect yet (${obs.detail}).`);
        else this.log("warn", `${name}: --resubmit-unconfirmed given; the previous submission is being treated as never sent.`);
      }
      step.state = "pending";
      await this.save();
    }

    // 2. Re-derive from chain before acting.
    const obs = await spec.observe();
    if (obs.done) {
      const attempted = (step?.attempts ?? 0) > 0;
      await this.markStep(name, attempted ? "succeeded" : "skipped", `already done on chain: ${obs.detail}`);
      return;
    }

    // 3. Act: record the attempt BEFORE the wallet sees the request.
    const built = await spec.build();
    const s = upsertStep(job, name, { state: "in_progress", attempts: (step?.attempts ?? 0) + 1, startedAt: this.ts() });
    delete s.error;
    job.facts.attemptCounters = { ...(job.facts.attemptCounters ?? {}), [name]: s.attempts! };
    await this.save();
    this.progress(built.summary);

    let result: SubmitResult;
    try {
      result = await this.deps.submit({ step: name, calldata: built.calldata, summary: built.summary, details: built.details });
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      // The wallet may have broadcast before failing (a network drop after submit is the recorded live case). Unknown, so halt.
      this.indeterminate(name, spec, `${name}: the wallet request failed with "${msg}" after the transaction may already have been submitted.`);
    }

    if (!result.hash) {
      // Nothing was broadcast: the host reports a failure before a hash existed.
      const code = /polic|denied/i.test(result.failureCode ?? "") ? "E_POLICY_DENIED" : /mfa|expired|reject/i.test(`${result.failureCode} ${result.status}`) ? "E_MFA_REQUIRED" : "E_INTERNAL";
      s.state = "failed";
      halt(
        {
          code,
          category: code === "E_INTERNAL" ? "internal" : "policy",
          retryability: code === "E_INTERNAL" ? "retryable" : "requires_user_action",
          message: `${name}: the wallet did not broadcast the transaction (${result.failureDescription ?? result.failureCode ?? result.status}).`,
          source: "wallet",
          recoveryAction: { kind: "resume_job", description: "Nothing was sent. Address the cause (approve the request, adjust policy) and run the job again.", resumeFrom: spec.resumeFrom },
        },
        "retryable_failed",
        spec.resumeFrom,
      );
    }

    const rec = this.receiptRecord(name, result.hash, s.attempts!, result.walletJobId);
    s.receipts = [...(s.receipts ?? []), rec];
    if (result.walletJobId) job.facts.executionPlane = { kind: "metamask-agent-wallet", ref: result.walletJobId };
    await this.save();

    const r = await this.readReceiptWithPatience(result.hash);
    if (!r) this.indeterminate(name, spec, `${name}: transaction ${result.hash} was submitted but its receipt could not be read.`, [result.hash]);
    this.fillReceipt(rec, r);
    await this.save();
    if (r.status === "reverted") {
      s.state = "failed";
      this.revertHalt(name, spec, result.hash);
    }
    await spec.confirm(r);
    await this.markStep(name, "succeeded", `tx ${result.hash}`);
  }
}

// ---------------------------------------------------------------------------
// The run

/** Run (or resume) a job to completion. Throws ProvisionHalt when it stops; returns the completed file otherwise. */
export async function runJob(deps: EngineDeps, file: JobFile, opts: RunOptions = {}): Promise<JobFile> {
  if (!intentIsConsistent(file.intent)) {
    throw new Error(`job ${file.job.jobId}: the stored intent's hashes do not recompute; refusing to execute it`);
  }
  if (file.job.state === "completed") return file;
  if (file.job.state === "terminal_failed" || file.job.state === "cancelled" || file.job.state === "expired") {
    const blocked = file.job.resume?.blockedBy;
    throw new ProvisionHalt(
      programError({ code: "E_JOB_TERMINAL", category: "validation", retryability: "terminal", message: `Job ${file.job.jobId} is ${file.job.state}${blocked ? `: ${blocked.message}` : ""}.`, recoveryAction: { kind: "abandon_job", description: blocked?.recoveryAction.description ?? "Start a new job." } }),
      file,
    );
  }
  const rt = new Runtime(deps, file, opts);
  const { chain } = deps;
  const d = deps.deployment;
  const job = file.job;
  const intent = file.intent;

  // A previous halt is cleared when the run restarts; the step's own record still shows the failure.
  if (job.resume?.blockedBy) {
    delete job.resume.blockedBy;
    delete job.resume.notBefore;
  }
  if (job.state === "retryable_failed") rt.setState(job.facts.erc8004AgentId ? "identity_bound" : job.outcome?.ens === "succeeded" ? "ens_registered" : "accepted");

  const run = async (name: StepName, body: () => Promise<void>): Promise<void> => {
    if (deps.signal?.aborted) throw new Error("aborted");
    try {
      await body();
    } catch (e) {
      if (e instanceof Halt) await rt.fail(name, e);
      if (e instanceof ProvisionHalt) throw e;
      const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      const isRead = e instanceof ReadError;
      await rt.fail(
        name,
        new Halt(
          {
            code: isRead ? "E_VERIFICATION_MISMATCH" : "E_INTERNAL",
            category: isRead ? "ens" : "internal",
            retryability: "retryable",
            message: `${name}: ${msg}`,
            recoveryAction: { kind: "resume_job", description: "Nothing was sent by this step. Fix the cause (RPC, inputs) and run the job again." },
          },
          "retryable_failed",
          name === "identity_bind" ? "identity_preflight" : (name as Exclude<StepName, "identity_bind">),
        ),
      );
    }
  };

  // Every step runs on every invocation. A step that already succeeded is
  // re-observed (reads only) and confirmed still done; that is what lets a
  // halt point back at an earlier step, and what makes a stale record
  // harmless: the chain, not the record, decides what is left to do.
  const steps = stepsFor(intent);
  for (const name of steps) {
    const existing = findStep(job, name);

    switch (name) {
      case "canonicality_check":
        await run(name, async () => {
          const det = await chain.detect();
          if (!det.isV2) {
            halt({ code: "E_DEPLOYMENT_DRIFT", category: "deployment", retryability: "terminal", message: `ENSv2 is not active on chain ${d.chainId}: ${det.reason}. Refusing to continue rather than falling back to ENSv1.`, source: "verifier", recoveryAction: { kind: "abandon_job", description: "Check the RPC endpoint and the deployment table. No wallet request was made." } }, "terminal_failed");
          }
          upsertStep(job, name, { attempts: (existing?.attempts ?? 0) + 1 });
          if (job.state === "direct_funding_ready") rt.setState("accepted");
          await rt.markStep(name, "succeeded", `${det.checks.length}/${det.checks.length} checks passed`);
        });
        break;

      case "resolver_deploy":
        await rt.txStep(name, {
          duplicate: "revert (CREATE2 address already has code) and only cost gas",
          inspect: `whether code exists at ${intent.resolverConfig.address} (\`mm ensv2 resolver plan\`) and \`mm wallet requests list\` for a pending approval`,
          resumeFrom: "resolver_deploy",
          observe: async () => {
            const s = await chain.resolverStatus(rt.owner);
            if (!isAddressEqual(s.predicted, intent.resolverConfig.address)) {
              halt({ code: "E_DEPLOYMENT_DRIFT", category: "deployment", retryability: "terminal", message: `The predicted resolver address is now ${s.predicted}; the intent committed to ${intent.resolverConfig.address}.`, recoveryAction: { kind: "abandon_job", description: "The factory's proxy logic changed. Start a new job." } }, "terminal_failed");
            }
            if (s.deployed && s.verified !== true) {
              halt({ code: "E_RESOLVER_NOT_PREPARED", category: "ens", retryability: "terminal", message: `Code exists at ${s.predicted} but VerifiableFactory does not attest it runs ${d.resolverImplementation}.`, recoveryAction: { kind: "manual_intervention", description: "Do not use this resolver. Report it with the address." } }, "terminal_failed");
            }
            return { done: s.deployed, detail: s.deployed ? `resolver ${s.predicted} exists and is factory-attested` : `no code at ${s.predicted}` };
          },
          build: async () => {
            const s = await chain.resolverStatus(rt.owner);
            const plan = buildDeployPlan(d, s);
            return { calldata: { to: plan.to, data: plan.data, value: 0n }, summary: `Deploy your ENSv2 resolver at ${plan.predicted}`, details: { factory: plan.to, resolver: plan.predicted, admin: rt.owner } };
          },
          confirm: async () => {
            const s = await chain.resolverStatus(rt.owner);
            if (!s.deployed) halt({ code: "E_VERIFICATION_MISMATCH", category: "ens", retryability: "retryable", message: `deploy succeeded but no code at ${s.predicted} yet`, recoveryAction: { kind: "resume_job", description: "Wait a block and run the job again." } });
            if (s.verified !== true) halt({ code: "E_RESOLVER_NOT_PREPARED", category: "ens", retryability: "terminal", message: `Code exists at ${s.predicted} but the factory does not attest it.`, recoveryAction: { kind: "manual_intervention", description: "Do not use this resolver. Report it." } }, "terminal_failed");
            rt.advance("resolver_prepared");
          },
        });
        break;

      case "commitment_submit":
        await rt.txStep(name, {
          duplicate: "revert while the first commitment is unexpired (UnexpiredCommitmentExists) and only cost gas",
          inspect: `the registrar's commitmentAt for ${job.facts.commitmentHash} and \`mm wallet requests list\``,
          resumeFrom: "commitment_submit",
          observe: async () => {
            const reg = await rt.registeredToOwner();
            if (reg.registered) {
              rt.recordRegistration(reg.whois);
              return { done: true, detail: "name already registered to this wallet" };
            }
            const c = rt.commitment;
            const [t0, now, avail] = await Promise.all([chain.commitmentTime(c.commitment), chain.chainTime(), chain.available(c.label)]);
            if (t0 === 0) return { done: false, detail: "no commitment on chain" };
            if (now >= t0 + avail.maxCommitmentAge) {
              // It landed (commitmentAt is set) and then aged out: a known outcome. A fresh commit is a new attempt, not a blind retry.
              rt.log("warn", `commitment ${c.commitment} expired (${avail.maxCommitmentAge / 3600} h); a fresh commit with the same parameters is needed`);
              return { done: false, settled: true, detail: `commitment landed at ${iso(t0)} and expired at ${iso(t0 + avail.maxCommitmentAge)}` };
            }
            job.facts.commitmentSubmittedAt = iso(t0);
            job.facts.commitmentMatureAt = iso(t0 + avail.minCommitmentAge + 1);
            job.facts.commitmentExpiresAt = iso(t0 + avail.maxCommitmentAge);
            rt.advance("commitment_confirmed");
            return { done: true, detail: `commitment on chain since ${iso(t0)}` };
          },
          build: async () => {
            const c = rt.commitment;
            // The resolver must exist before commit: its address is bound into the commitment.
            const s = await chain.resolverStatus(rt.owner);
            if (!s.deployed || s.verified !== true || !isAddressEqual(s.predicted, c.resolver)) {
              halt({ code: "E_RESOLVER_NOT_PREPARED", category: "ens", retryability: "requires_user_action", message: `The committed resolver ${c.resolver} is not deployed and attested.`, recoveryAction: { kind: "manual_intervention", description: "Run `mm ensv2 resolver deploy`, then resume." } }, "retryable_failed", "resolver_deploy");
            }
            rt.advance("commitment_submitted");
            return { calldata: buildCommit(d, c.commitment), summary: `Commit to register ${rt.name}`, details: { name: rt.name, resolver: c.resolver, commitment: c.commitment } };
          },
          confirm: async () => {
            const t0 = await chain.commitmentTime(rt.commitment.commitment);
            if (t0 === 0) halt({ code: "E_VERIFICATION_MISMATCH", category: "ens", retryability: "retryable", message: "commit succeeded but commitmentAt is still 0", recoveryAction: { kind: "resume_job", description: "Wait a block and run the job again." } });
            const avail = await chain.available(rt.commitment.label);
            job.facts.commitmentSubmittedAt = iso(t0);
            job.facts.commitmentMatureAt = iso(t0 + avail.minCommitmentAge + 1);
            job.facts.commitmentExpiresAt = iso(t0 + avail.maxCommitmentAge);
            rt.advance("commitment_confirmed");
          },
        });
        break;

      case "payment_token_approve":
        await rt.txStep(name, {
          duplicate: "set the same allowance again and only cost gas",
          inspect: `the payment token allowance for the registrar (\`mm ensv2 register\` reports it) and \`mm wallet requests list\``,
          resumeFrom: "payment_token_approve",
          observe: async () => {
            const reg = await rt.registeredToOwner();
            if (reg.registered) {
              rt.recordRegistration(reg.whois);
              return { done: true, detail: "name already registered to this wallet" };
            }
            const { allowance } = await chain.tokenState(rt.owner);
            const need = BigInt(intent.maxSpend.maxTotalAmount);
            if (need === 0n) return { done: true, detail: "nothing to pay" };
            return { done: allowance >= need, detail: `allowance ${allowance} vs ceiling ${need}` };
          },
          build: async () => ({ calldata: buildApprove(d, BigInt(intent.maxSpend.maxTotalAmount)), summary: `Approve ${intent.maxSpend.maxTotalAmount} payment-token units for the ENSv2 registrar`, details: { spender: d.registrar, token: d.paymentToken, amount: intent.maxSpend.maxTotalAmount } }),
          confirm: async () => {
            const { allowance } = await chain.tokenState(rt.owner);
            if (allowance < BigInt(intent.maxSpend.maxTotalAmount)) halt({ code: "E_VERIFICATION_MISMATCH", category: "funding", retryability: "retryable", message: "approve succeeded but the allowance is not reflected yet", recoveryAction: { kind: "resume_job", description: "Wait a block and run the job again." } });
          },
        });
        break;

      case "commitment_wait":
        await run(name, async () => {
          const reg = await rt.registeredToOwner();
          if (reg.registered) {
            rt.recordRegistration(reg.whois);
            await rt.markStep(name, "skipped", "name already registered to this wallet");
            return;
          }
          const c = rt.commitment;
          const avail = await chain.available(c.label);
          const t0 = await chain.commitmentTime(c.commitment);
          if (t0 === 0) halt({ code: "E_VERIFICATION_MISMATCH", category: "ens", retryability: "retryable", message: "the commitment is not visible on chain", recoveryAction: { kind: "resume_job", description: "Run the job again; commitment_submit will re-observe and re-commit if needed.", resumeFrom: "commitment_submit" } }, "retryable_failed", "commitment_submit");
          const ready = t0 + avail.minCommitmentAge + 1;
          const expiresAt = t0 + avail.maxCommitmentAge;
          let now = await chain.chainTime();
          if (now < ready) {
            rt.advance("commitment_maturing");
            upsertStep(job, name, { state: "in_progress", attempts: (findStep(job, name)?.attempts ?? 0) + 1, startedAt: rt.ts() });
            job.resume = { ...(job.resume ?? { resumable: true }), notBefore: iso(ready) };
            await rt.save();
          }
          while (now < ready) {
            if (deps.signal?.aborted) halt({ code: "E_COMMITMENT_TOO_YOUNG", category: "ens", retryability: "retryable", message: `Interrupted while the commitment matures; register is allowed from ${iso(ready)}.`, recoveryAction: { kind: "await_commitment_age", description: "Run the job again after that time.", notBefore: iso(ready) } }, "retryable_failed", "commitment_wait", iso(ready));
            rt.progress(`Commitment aging: ${ready - now}s until register is allowed`);
            await rt.sleep(Math.min(5000, Math.max(1000, (ready - now) * 1000)));
            now = await chain.chainTime();
          }
          rt.progress();
          if (now >= expiresAt) {
            halt({ code: "E_COMMITMENT_EXPIRED", category: "ens", retryability: "retryable", message: `The commitment expired at ${iso(expiresAt)} before register was called.`, recoveryAction: { kind: "resume_job", description: "Run the job again; a fresh commit with the same parameters will be sent.", resumeFrom: "commitment_submit" } }, "retryable_failed", "commitment_submit");
          }
          delete job.resume?.notBefore;
          await rt.markStep(name, "succeeded", `matured at ${iso(ready)}`);
        });
        break;

      case "price_recheck":
        await run(name, async () => {
          const reg = await rt.registeredToOwner();
          if (reg.registered) {
            rt.recordRegistration(reg.whois);
            await rt.markStep(name, "skipped", "name already registered to this wallet");
            return;
          }
          const c = rt.commitment;
          const [avail, q, funds] = await Promise.all([chain.available(c.label), chain.quote(c.label, BigInt(c.durationSeconds)), chain.tokenState(rt.owner)]);
          if (!avail.available) halt({ code: "E_NAME_UNAVAILABLE", category: "ens", retryability: "terminal", message: `${rt.name} is no longer available.`, recoveryAction: { kind: "abandon_job", description: "Check `mm ensv2 whois`. Nothing was paid." } }, "terminal_failed");
          const total = BigInt(q.total);
          const ceiling = BigInt(intent.maxSpend.maxTotalAmount);
          if (total > ceiling) halt({ code: "E_PRICE_EXCEEDS_MAX_SPEND", category: "funding", retryability: "requires_user_action", message: `The registrar now quotes ${q.formatted.total} ${q.paymentToken.symbol} (${total} units); the intent's ceiling is ${ceiling} units.`, recoveryAction: { kind: "refresh_quote_and_resume", description: "Start a new job with a higher --max-spend. This job will not pay above its ceiling." } }, "retryable_failed", "price_recheck");
          if (funds.balance < total) halt({ code: "E_INSUFFICIENT_FUNDS", category: "funding", retryability: "requires_user_action", message: `Registration costs ${q.formatted.total} ${q.paymentToken.symbol}; this wallet holds ${funds.balance} units.`, recoveryAction: { kind: "fund_wallet_and_resume", description: "On Sepolia, run `mm ensv2 faucet`, then run the job again." } }, "retryable_failed", "price_recheck");
          if (funds.allowance < total) halt({ code: "E_INSUFFICIENT_ALLOWANCE", category: "funding", retryability: "retryable", message: `The registrar's allowance is ${funds.allowance} units; ${total} are needed.`, recoveryAction: { kind: "grant_allowance_and_resume", description: "Run the job again; payment_token_approve will be re-observed.", resumeFrom: "payment_token_approve" } }, "retryable_failed", "payment_token_approve");
          await rt.markStep(name, "succeeded", `${q.formatted.total} ${q.paymentToken.symbol} ≤ ceiling ${ceiling}`);
        });
        break;

      case "registration_submit":
        await rt.txStep(name, {
          duplicate: "revert (the name is already registered) and only cost gas — the registrar cannot register a name twice",
          inspect: `\`mm ensv2 whois ${rt.name}\` for the owner and \`mm wallet requests list\` for a pending approval`,
          resumeFrom: "registration_submit",
          observe: async () => {
            const reg = await rt.registeredToOwner();
            if (reg.registered) {
              rt.recordRegistration(reg.whois);
              rt.advance("ens_registered");
              return { done: true, detail: `registered to ${rt.owner}, token ${reg.whois.tokenId}` };
            }
            return { done: false, detail: `registry says ${reg.whois.status}` };
          },
          build: async () => {
            const c = rt.commitment;
            const [t0, now, avail] = await Promise.all([chain.commitmentTime(c.commitment), chain.chainTime(), chain.available(c.label)]);
            if (t0 === 0 || now >= t0 + avail.maxCommitmentAge) halt({ code: "E_COMMITMENT_EXPIRED", category: "ens", retryability: "retryable", message: "No live commitment for this registration.", recoveryAction: { kind: "resume_job", description: "Run the job again; it will re-commit.", resumeFrom: "commitment_submit" } }, "retryable_failed", "commitment_submit");
            if (now < t0 + avail.minCommitmentAge + 1) halt({ code: "E_COMMITMENT_TOO_YOUNG", category: "ens", retryability: "retryable", message: `The commitment matures at ${iso(t0 + avail.minCommitmentAge + 1)}.`, recoveryAction: { kind: "await_commitment_age", description: "Run the job again after that time.", notBefore: iso(t0 + avail.minCommitmentAge + 1) } }, "retryable_failed", "commitment_wait", iso(t0 + avail.minCommitmentAge + 1));
            rt.advance("registration_submitted");
            return { calldata: buildRegister(d, rt.commitmentParams), summary: `Register ${rt.name} for ${(c.durationSeconds / 31536000).toFixed(2)} year(s) — up to ${intent.maxSpend.maxTotalAmount} payment-token units`, details: { name: rt.name, owner: rt.owner, resolver: c.resolver, ceiling: intent.maxSpend.maxTotalAmount } };
          },
          confirm: async () => {
            const reg = await rt.registeredToOwner();
            if (!reg.registered) halt({ code: "E_VERIFICATION_MISMATCH", category: "ens", retryability: "retryable", message: `register succeeded but the registry reports ${reg.whois.status}`, recoveryAction: { kind: "resume_job", description: "Wait a block and run the job again." } });
            const r = await chain.resolverInfo(rt.name);
            if (r.kind !== "own" || !r.resolver || !isAddressEqual(r.resolver, intent.resolverConfig.address)) {
              halt({ code: "E_VERIFICATION_MISMATCH", category: "ens", retryability: "terminal", message: `${rt.name} registered but its resolver is ${r.resolver ?? "none"} (${r.kind}), not the committed ${intent.resolverConfig.address}.`, source: "verifier", recoveryAction: { kind: "manual_intervention", description: "Report this with the registration transaction hash." } }, "terminal_failed");
            }
            rt.recordRegistration(reg.whois);
            rt.advance("ens_registered");
          },
        });
        break;

      case "identity_preflight":
        await run(name, async () => {
          const ic = intent.identityConfig!;
          const impl = await chain.adapterImplementation();
          if (!isAddressEqual(impl, ic.adapterImplementation)) {
            halt({ code: "E_DEPLOYMENT_DRIFT", category: "identity", retryability: "terminal", message: `Adapter8004's implementation is now ${impl}; the intent pinned ${ic.adapterImplementation}.`, source: "verifier", recoveryAction: { kind: "abandon_job", description: "The adapter was upgraded since this job was created. Start a new job so the intent pins the live implementation." } }, "terminal_failed");
          }
          const reg = await rt.registeredToOwner();
          if (!reg.registered) halt({ code: "E_NAME_UNAVAILABLE", category: "ens", retryability: "terminal", message: `${rt.name} is ${reg.whois.status}; it must be registered to this wallet before identity can be bound.`, recoveryAction: { kind: "abandon_job", description: "The registration did not hold (expired or never completed)." } }, "terminal_failed");
          const anchor = job.facts.identityAnchor;
          const current = BigInt(reg.whois.tokenId);
          if (anchor && BigInt(anchor.value) !== current) {
            if (BigInt(anchor.value) >> 32n !== current >> 32n) {
              halt({ code: "E_IDENTITY_TOKEN_ID_STALE", category: "identity", retryability: "terminal", message: `The name's canonical id changed since registration (anchor ${anchor.value}, current ${current}).`, recoveryAction: { kind: "abandon_job", description: "This is not the registration this job made." } }, "terminal_failed");
            }
            rt.log("warn", `identity_preflight: the token id regenerated since registration (a role change); binding will use the current id ${current}.`);
          }
          job.facts.currentTokenId = current.toString(); // D-010: re-read immediately before binding, never carried forward.

          // An agent already bound to this token by this owner (this job's own interrupted bind, or a manual `agent register`) is reused, never duplicated.
          // An agent this owner bound that is now ORPHANED (a role change regenerated the token id after the bind) is D-010's terminal case: no unbind exists and this job never mints a second agent on its own.
          rt.discoveredAgentId = null;
          if (!job.facts.erc8004AgentId) {
            const found = await rt.scanBindings();
            if (found.bound !== null) {
              rt.discoveredAgentId = found.bound;
              rt.log("info", `identity_preflight: agent #${found.bound} is already bound to ${rt.name}'s current token; it will be reused.`);
            } else if (found.orphaned !== null) {
              rt.orphanedHalt(found.orphaned);
            }
          }
          if (!job.facts.erc8004AgentId) rt.advance("identity_pending");
          if (job.outcome?.identity !== "succeeded") job.outcome = { ...(job.outcome ?? {}), identity: "pending" };
          upsertStep(job, name, { attempts: (findStep(job, name)?.attempts ?? 0) + 1 });
          await rt.markStep(name, "succeeded", `adapter implementation ${impl} pinned; current token ${current}`);
        });
        break;

      case "identity_bind":
        await rt.txStep(name, {
          duplicate: "MINT A SECOND ERC-8004 AGENT bound to the same name (bindings are immutable and cannot be undone)",
          inspect: `\`mm ensv2 agent info ${rt.name}\` (scans AgentBound events) and \`mm wallet requests list\``,
          resumeFrom: "identity_preflight",
          indeterminateCode: "E_IDENTITY_BINDING_FAILED",
          revertCode: "E_IDENTITY_BINDING_FAILED",
          observe: async () => {
            const known = job.facts.erc8004AgentId ? BigInt(job.facts.erc8004AgentId) : rt.discoveredAgentId;
            if (known === null) {
              // Re-scan: a bind submitted by an interrupted run may have landed since preflight.
              const found = await rt.scanBindings();
              if (found.bound !== null) {
                rt.discoveredAgentId = found.bound;
                job.facts.erc8004AgentId = found.bound.toString();
                rt.advance("identity_bound");
                return { done: true, detail: `agent #${found.bound} found bound to the current token` };
              }
              if (found.orphaned !== null) rt.orphanedHalt(found.orphaned);
              return { done: false, detail: `no agent bound to ${rt.name}'s current token (scanned blocks ${found.scannedFrom}-${found.scannedTo})` };
            }
            const info = await chain.agentInfo(rt.name, known);
            if (info.status === "orphaned") rt.orphanedHalt(known);
            if (info.status === "bound" && info.registryMatches) {
              job.facts.erc8004AgentId = known.toString();
              rt.advance("identity_bound");
              return { done: true, detail: `agent #${known} bound to the current token` };
            }
            return { done: false, detail: `agent #${known} is ${info.status}` };
          },
          build: async () => {
            const ic = intent.identityConfig!;
            const w = await chain.whois(rt.name);
            if (w.status !== "REGISTERED" || !w.owner || !isAddressEqual(w.owner, rt.owner)) halt({ code: "E_NAME_UNAVAILABLE", category: "ens", retryability: "terminal", message: `${rt.name} is no longer registered to this wallet.`, recoveryAction: { kind: "abandon_job", description: "Nothing was minted." } }, "terminal_failed");
            const tokenId = BigInt(w.tokenId);
            job.facts.currentTokenId = tokenId.toString();
            const data = encodeFunctionData({ abi: adapter8004Abi, functionName: "register", args: [TOKEN_STANDARD.ERC721, w.registry, tokenId, ic.agentUri] });
            return { calldata: { to: ic.adapterProxy, data, value: 0n }, summary: `Mint an ERC-8004 agent bound to ${rt.name}`, details: { adapter: ic.adapterProxy, name: rt.name, tokenId: `0x${tokenId.toString(16)}`, agentURI: ic.agentUri } };
          },
          confirm: async (receipt) => {
            const id = agentIdFromReceipt(receipt, d.adapter8004);
            if (id === null) halt({ code: "E_VERIFICATION_MISMATCH", category: "identity", retryability: "terminal", message: "the bind transaction succeeded but emitted no AgentBound event", source: "verifier", recoveryAction: { kind: "manual_intervention", description: "Report this with the transaction hash." } }, "terminal_failed");
            const info = await chain.agentInfo(rt.name, id);
            if (info.status !== "bound" || !info.registryMatches || !info.nftHeldByAdapter) {
              halt({ code: "E_IDENTITY_BINDING_FAILED", category: "identity", retryability: "terminal", message: `Agent #${id} was minted but its binding does not match ${rt.name}: ${JSON.stringify(info.binding)}.`, source: "verifier", recoveryAction: { kind: "manual_intervention", description: "Report this with the transaction hash." } }, "terminal_failed");
            }
            job.facts.erc8004AgentId = id.toString();
            rt.advance("identity_bound");
          },
        });
        break;

      case "identity_verify":
        await run(name, async () => {
          const id = BigInt(job.facts.erc8004AgentId!);
          const info = await chain.agentInfo(rt.name, id);
          if (info.status === "orphaned") halt({ code: "E_IDENTITY_BINDING_ORPHANED", category: "identity", retryability: "terminal", message: `Agent #${id} is bound to token ${info.binding.tokenId}, but ${rt.name} is now token ${info.currentTokenId}.`, source: "verifier", recoveryAction: { kind: "reregister_identity", description: "Mint a fresh agent against the current token; there is no unbind." } }, "terminal_failed");
          if (info.status !== "bound" || !info.registryMatches) halt({ code: "E_IDENTITY_BINDING_FAILED", category: "identity", retryability: "terminal", message: `Agent #${id} is ${info.status} on the adapter.`, source: "verifier", recoveryAction: { kind: "manual_intervention", description: "Report this." } }, "terminal_failed");
          if (!info.ownerIsController) halt({ code: "E_IDENTITY_BINDING_FAILED", category: "identity", retryability: "terminal", message: `The adapter does not report ${rt.owner} as controller of agent #${id}.`, source: "verifier", recoveryAction: { kind: "manual_intervention", description: "Report this." } }, "terminal_failed");
          const meta = await chain.bindingMetadata(id);
          if (!meta || !isAddressEqual(meta, d.adapter8004)) halt({ code: "E_IDENTITY_METADATA_FAILED", category: "identity", retryability: "terminal", message: `The ERC-8004 registry's agent-binding metadata for #${id} is ${meta ?? "empty"}, not the adapter ${d.adapter8004}.`, source: "verifier", recoveryAction: { kind: "manual_intervention", description: "The identity is discoverable as pointing at a different binding contract. Report this." } }, "terminal_failed");
          job.outcome = { ...(job.outcome ?? {}), identity: "succeeded" };
          upsertStep(job, name, { attempts: (findStep(job, name)?.attempts ?? 0) + 1 });
          await rt.markStep(name, "succeeded", `agent #${id} bound, controller ok, binding metadata ok`);
        });
        break;

      case "records_configure": {
        const desired = desiredRecords(file, d);
        await rt.txStep(name, {
          duplicate: "rewrite the same record values and only cost gas",
          inspect: `\`mm ensv2 records get ${rt.name}\` and \`mm wallet requests list\``,
          resumeFrom: "records_configure",
          observe: async () => {
            if (!desired.addr && Object.keys(desired.texts).length === 0) return { done: true, detail: "no records requested" };
            const r = await chain.resolverInfo(rt.name);
            if (r.kind !== "own" || !r.resolver || !isAddressEqual(r.resolver, intent.resolverConfig.address)) {
              halt({ code: "E_RESOLVER_NOT_PREPARED", category: "ens", retryability: "terminal", message: `${rt.name}'s resolver is ${r.resolver ?? "none"} (${r.kind}), not the wallet's ${intent.resolverConfig.address}.`, recoveryAction: { kind: "manual_intervention", description: "Records can only be written to the resolver this wallet administers." } }, "terminal_failed");
            }
            const cur = await chain.currentRecords(rt.name, Object.keys(desired.texts));
            const diff = diffRecords(rt.name, cur, desired);
            const pending = Object.keys(diff.changes);
            return { done: pending.length === 0, detail: pending.length ? `${pending.length} record(s) differ: ${pending.join(", ")}` : `all ${diff.unchanged.length} records already set` };
          },
          build: async () => {
            const cur = await chain.currentRecords(rt.name, Object.keys(desired.texts));
            const diff = diffRecords(rt.name, cur, desired);
            const { calldata } = buildRecordsMulticall(intent.resolverConfig.address, namehash(rt.name), diff.changes);
            const keys = Object.keys(diff.changes);
            return { calldata: calldata!, summary: `Set ${keys.length} record${keys.length === 1 ? "" : "s"} on ${rt.name}: ${keys.join(", ")}`, details: Object.fromEntries(keys.map((k) => [k, diff.changes[k]!.to.length > 60 ? diff.changes[k]!.to.slice(0, 57) + "…" : diff.changes[k]!.to])) };
          },
          confirm: async () => {
            const cur = await chain.currentRecords(rt.name, Object.keys(desired.texts));
            const diff = diffRecords(rt.name, cur, desired);
            if (Object.keys(diff.changes).length) halt({ code: "E_VERIFICATION_MISMATCH", category: "ens", retryability: "retryable", message: `the multicall succeeded but ${Object.keys(diff.changes).join(", ")} still differ through the Universal Resolver`, recoveryAction: { kind: "resume_job", description: "Wait a block and run the job again." } });
          },
        });
        break;
      }

      case "ens_verify":
        await run(name, async () => {
          upsertStep(job, name, { state: "in_progress", attempts: (findStep(job, name)?.attempts ?? 0) + 1, startedAt: rt.ts() });
          const verification = await verifyProvisioning([deps.chain, deps.verifyChain], d, file, rt.ts());
          job.result = { verification, name: rt.name, owner: rt.owner, transactionHashes: transactionHashes(job) };
          const terminal = verification.errors?.find((e) => e.retryability === "terminal");
          if (verification.outcome === "verified") {
            job.outcome = { ens: "succeeded", identity: intent.identity === "erc8004" ? "succeeded" : "not_requested", payment: "not_required" };
            rt.setState("completed");
            await rt.markStep(name, "succeeded", "verified through two endpoints");
            return;
          }
          if (terminal) {
            job.outcome = { ...(job.outcome ?? {}), identity: "failed" };
            halt({ ...terminal, evidence: terminal.evidence ?? {} }, "terminal_failed");
          }
          const failed = verification.checks.filter((c) => !c.passed).map((c) => c.id);
          halt(
            {
              code: verification.evidenceSource.endpointsAgree ? "E_VERIFICATION_MISMATCH" : "E_RPC_DISAGREEMENT",
              category: verification.evidenceSource.endpointsAgree ? "ens" : "network",
              retryability: "retryable",
              message: verification.evidenceSource.endpointsAgree ? `Verification outcome ${verification.outcome}: failed checks ${failed.join(", ")}.` : "The two RPC endpoints disagree about the name's state; a verified result cannot rest on disagreeing evidence.",
              source: "verifier",
              recoveryAction: { kind: "resume_job", description: "Wait a block and run the job again; nothing will be resent unless the chain shows a step undone.", resumeFrom: "ens_verify" },
            },
            "retryable_failed",
            "ens_verify",
          );
        });
        break;

      default:
        break;
    }
  }
  return file;
}

/** The record set the job writes: the intent's records plus the ENSIP-25 link once the agent id is known. */
export function desiredRecords(file: JobFile, d: EnsV2Deployment): DesiredRecords {
  const out: DesiredRecords = { texts: {} };
  for (const r of file.intent.resolverConfig.records) {
    if (r.kind === "addr") out.addr = getAddress(r.value);
    else if (r.kind === "text") out.texts[r.key] = r.value;
  }
  if (file.intent.identity === "erc8004" && file.intent.identityConfig?.publishEnsipRecords && file.job.facts.erc8004AgentId) {
    out.texts[ensip25Key(d.chainId, d.identityRegistry, file.job.facts.erc8004AgentId)] = "1";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Observation (dry-run): what a resume would do, step by step, without touching anything.

export type StepObservation = { step: StepName; recorded: string; observed: string; wouldSubmit: boolean };

export async function observeJob(chain: ProvisionChain, d: EnsV2Deployment, file: JobFile): Promise<StepObservation[]> {
  const job = file.job;
  const intent = file.intent;
  const out: StepObservation[] = [];
  const rec = (n: StepName) => findStep(job, n)?.state ?? "not started";
  const w = await chain.whois(job.facts.normalizedName).catch(() => null);
  const registered = !!w && w.status === "REGISTERED" && !!w.owner && isAddressEqual(w.owner, job.facts.owner);
  for (const step of stepsFor(intent)) {
    switch (step) {
      case "canonicality_check": {
        const det = await chain.detect();
        out.push({ step, recorded: rec(step), observed: det.isV2 ? "ENSv2 active" : `NOT ENSv2: ${det.reason}`, wouldSubmit: false });
        break;
      }
      case "resolver_deploy": {
        const s = await chain.resolverStatus(job.facts.owner);
        out.push({ step, recorded: rec(step), observed: s.deployed ? `deployed at ${s.predicted}${s.verified ? ", attested" : ", NOT attested"}` : `no code at ${s.predicted}`, wouldSubmit: !s.deployed });
        break;
      }
      case "commitment_submit": {
        if (registered) {
          out.push({ step, recorded: rec(step), observed: "name registered to owner", wouldSubmit: false });
          break;
        }
        const c = file.private.commitment;
        const t0 = c ? await chain.commitmentTime(c.commitment) : 0;
        const now = await chain.chainTime();
        const avail = c ? await chain.available(c.label) : null;
        const expired = !!avail && t0 > 0 && now >= t0 + avail.maxCommitmentAge;
        out.push({ step, recorded: rec(step), observed: t0 === 0 ? "no commitment on chain" : expired ? "commitment expired" : `commitment on chain since ${iso(t0)}`, wouldSubmit: t0 === 0 || expired });
        break;
      }
      case "payment_token_approve": {
        if (registered) {
          out.push({ step, recorded: rec(step), observed: "name registered to owner", wouldSubmit: false });
          break;
        }
        const { allowance } = await chain.tokenState(job.facts.owner);
        const need = BigInt(intent.maxSpend.maxTotalAmount);
        out.push({ step, recorded: rec(step), observed: `allowance ${allowance}, ceiling ${need}`, wouldSubmit: allowance < need });
        break;
      }
      case "commitment_wait":
      case "price_recheck":
        out.push({ step, recorded: rec(step), observed: registered ? "name registered to owner" : "read-only step", wouldSubmit: false });
        break;
      case "registration_submit":
        out.push({ step, recorded: rec(step), observed: registered ? `registered to owner, token ${w!.tokenId}` : `registry says ${w?.status ?? "unknown"}`, wouldSubmit: !registered });
        break;
      case "identity_preflight":
        out.push({ step, recorded: rec(step), observed: registered ? "would re-read token id and adapter implementation" : "blocked until registered", wouldSubmit: false });
        break;
      case "identity_bind": {
        if (!registered) {
          out.push({ step, recorded: rec(step), observed: "blocked until registered", wouldSubmit: false });
          break;
        }
        const scan = await chain.findAgentIds(job.facts.normalizedName);
        let bound: bigint | null = null;
        for (const id of scan.agentIds) {
          const info = await chain.agentInfo(job.facts.normalizedName, id);
          if (info.status === "bound") {
            bound = id;
            break;
          }
        }
        out.push({ step, recorded: rec(step), observed: bound !== null ? `agent #${bound} bound to the current token` : "no agent bound to the current token", wouldSubmit: bound === null });
        break;
      }
      case "identity_verify":
        out.push({ step, recorded: rec(step), observed: "read-only step", wouldSubmit: false });
        break;
      case "records_configure": {
        const desired = desiredRecords(file, d);
        if (!registered) {
          out.push({ step, recorded: rec(step), observed: "blocked until registered", wouldSubmit: false });
          break;
        }
        try {
          const cur = await chain.currentRecords(job.facts.normalizedName, Object.keys(desired.texts));
          const diff = diffRecords(job.facts.normalizedName, cur, desired);
          const pending = Object.keys(diff.changes);
          out.push({ step, recorded: rec(step), observed: pending.length ? `${pending.length} record(s) differ: ${pending.join(", ")}` : "all records already set", wouldSubmit: pending.length > 0 });
        } catch (e) {
          out.push({ step, recorded: rec(step), observed: `lookup failed: ${e instanceof Error ? e.message : String(e)}`, wouldSubmit: false });
        }
        break;
      }
      case "ens_verify":
        out.push({ step, recorded: rec(step), observed: "dual-endpoint verification, read-only", wouldSubmit: false });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification (verification-result 1.0.0), computed from two independent endpoints.

type Evidence = {
  registryOk: boolean;
  observedRegistry: Address;
  whois: WhoisInfo | null;
  resolver: { kind: string; resolver: Address | null } | null;
  forward: string | null;
  forwardStatus: string;
  records: Record<string, string | null>;
  recordsStatus: Record<string, string>;
  identity: null | { status: string; boundTokenId: string; currentTokenId: string; controller: boolean; nftHeldByAdapter: boolean; standard: number; agentURI: string; ensip25: boolean | null; metadata: Address | null; registryMatches: boolean };
  blockNumber: bigint;
};

async function collectEvidence(chain: ProvisionChain, d: EnsV2Deployment, file: JobFile): Promise<Evidence> {
  const name = file.job.facts.normalizedName;
  const det = await chain.detect();
  const whois = await chain.whois(name).catch(() => null);
  const resolver = await chain.resolverInfo(name).catch(() => null);
  const fwd = await chain.forwardAddress(name);
  const desired = desiredRecords(file, d);
  const cur = await chain.currentRecords(name, Object.keys(desired.texts));
  const records: Record<string, string | null> = {};
  const recordsStatus: Record<string, string> = {};
  if (desired.addr) (records.addr = cur.addr.value), (recordsStatus.addr = cur.addr.status);
  for (const k of Object.keys(desired.texts)) (records[k] = cur.texts[k]?.value ?? null), (recordsStatus[k] = cur.texts[k]?.status ?? "lookup_failed");
  let identity: Evidence["identity"] = null;
  if (file.intent.identity === "erc8004" && file.job.facts.erc8004AgentId) {
    const id = BigInt(file.job.facts.erc8004AgentId);
    const info = await chain.agentInfo(name, id);
    const metadata = await chain.bindingMetadata(id).catch(() => null);
    identity = { status: info.status, boundTokenId: BigInt(info.binding.tokenId).toString(), currentTokenId: BigInt(info.currentTokenId).toString(), controller: info.ownerIsController, nftHeldByAdapter: info.nftHeldByAdapter, standard: info.binding.standard, agentURI: info.agentURI, ensip25: info.ensip25Linked, metadata, registryMatches: info.registryMatches };
  }
  return {
    registryOk: det.isV2 && isAddressEqual(det.ethRegistry, d.registry),
    observedRegistry: det.isV2 ? det.ethRegistry : zeroAddress,
    whois,
    resolver: resolver ? { kind: resolver.kind, resolver: resolver.resolver } : null,
    forward: fwd.value,
    forwardStatus: fwd.status,
    records,
    recordsStatus,
    identity,
    blockNumber: await chain.blockNumber(),
  };
}

const comparable = (e: Evidence) => JSON.stringify({ ...e, blockNumber: undefined, whois: e.whois && { status: e.whois.status, owner: e.whois.owner?.toLowerCase(), expiry: e.whois.expiry, tokenId: e.whois.tokenId, resolver: e.whois.resolver?.toLowerCase() } }, (_, v) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v));

export async function verifyProvisioning(chains: [ProvisionChain, ProvisionChain], d: EnsV2Deployment, file: JobFile, verifiedAt: string = nowIso()): Promise<VerificationResult> {
  const { intent, job } = file;
  const name = job.facts.normalizedName;
  const owner = job.facts.owner;
  const [a, b] = await Promise.all([collectEvidence(chains[0], d, file), collectEvidence(chains[1], d, file)]);
  const endpointsAgree = comparable(a) === comparable(b);
  const e = a;

  const checks: VerificationCheck[] = [];
  const check = (id: string, description: string, expected: string | boolean | null, actual: string | boolean | null, severity: "required" | "advisory" = "required") => {
    const passed = typeof expected === "string" && typeof actual === "string" ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
    checks.push({ id, description, expected, actual, passed, severity });
    return passed;
  };

  check("registry-canonical", "UR findCanonicalRegistry matches the deployment table", d.registry, e.observedRegistry);
  const registered = !!e.whois && e.whois.status === "REGISTERED";
  check("registered", "the registry reports the name REGISTERED", true, registered);
  check("owner-matches", "final owner equals the intent owner", owner, e.whois?.owner ?? null);
  check("resolver-own", "the name's own resolver (offset 0) is the committed resolver", intent.resolverConfig.address, e.resolver?.kind === "own" ? e.resolver.resolver : null);
  const addrRecord = intent.resolverConfig.records.find((r) => r.kind === "addr");
  if (addrRecord) check("forward-resolution", "name forward-resolves to the intended address through the UR", addrRecord.value, e.forward);
  for (const r of intent.resolverConfig.records) {
    if (r.kind === "text") check(`record:${r.key}`, `text record ${r.key} reads back through the UR`, r.value, e.records[r.key] ?? null);
  }
  const ensOk = checks.every((c) => c.passed);

  let identity: VerificationResult["identity"];
  const errors: ProgramError[] = [];
  if (intent.identity === "erc8004") {
    const ic = intent.identityConfig!;
    if (e.identity) {
      const bound = e.identity.status !== "unbound" && e.identity.registryMatches;
      check("identity-bound", "an ERC-8004 agent is bound to the name's token on the adapter", true, bound);
      check("bound-token-is-current", "the bound token id equals the name's current token id", e.identity.currentTokenId, e.identity.boundTokenId);
      check("identity-controller", "the owner controls the agent through the binding", true, e.identity.controller);
      check("binding-metadata-matches", "ERC-8004 agent-binding metadata points at the adapter", d.adapter8004, e.identity.metadata);
      check("ensip25-link", "the ENSIP-25 agent-registration record is published on the name", true, e.identity.ensip25 === true);
      identity = {
        requested: "erc8004",
        bound,
        agentId: job.facts.erc8004AgentId!,
        adapterProxy: ic.adapterProxy,
        adapterImplementation: ic.adapterImplementation,
        boundTokenId: e.identity.boundTokenId,
        boundTokenIdIsCurrent: e.identity.status === "bound",
        controlVerified: e.identity.controller,
        agentUri: e.identity.agentURI,
        ensipRecordsPublished: e.identity.ensip25 === true,
        ...(bound
          ? {
              anchor: { kind: "token-id", value: e.identity.boundTokenId, invariantUnderTokenIdChange: false, survivesReregistration: false, epochEqualityChecked: false },
              bindingStandard: "erc721",
              bindingStandardId: e.identity.standard,
              ...(e.identity.metadata ? { bindingMetadataAddress: e.identity.metadata } : {}),
              bindingMetadataMatches: !!e.identity.metadata && isAddressEqual(e.identity.metadata, d.adapter8004),
            }
          : {}),
      };
      if (e.identity.status === "orphaned") {
        errors.push(programError({ code: "E_IDENTITY_BINDING_ORPHANED", category: "identity", retryability: "terminal", message: `Agent #${job.facts.erc8004AgentId} is bound to token ${e.identity.boundTokenId}; the name is now token ${e.identity.currentTokenId}. No address controls the agent through this binding and there is no unbind.`, occurredAt: verifiedAt, step: "identity_verify", source: "verifier", recoveryAction: { kind: "reregister_identity", description: "Mint a fresh ERC-8004 agent against the current token." }, evidence: { transactionHashes: transactionHashes(job), intentHash: job.intentHash, deploymentId: d.deploymentId } }));
      }
    } else {
      check("identity-bound", "an ERC-8004 agent is bound to the name's token on the adapter", true, false);
      identity = { requested: "erc8004", bound: false, adapterProxy: ic.adapterProxy, adapterImplementation: ic.adapterImplementation, controlVerified: false, ensipRecordsPublished: false };
    }
  }
  const identityOk = checks.every((c) => c.passed);

  if (!endpointsAgree) {
    errors.push(programError({ code: "E_RPC_DISAGREEMENT", category: "network", retryability: "retryable", message: "The two RPC endpoints returned different evidence for the name.", occurredAt: verifiedAt, step: "ens_verify", source: "verifier", recoveryAction: { kind: "resume_job", description: "Wait a block and run the verification again.", resumeFrom: "ens_verify" } }));
  }

  const outcome: VerificationResult["outcome"] = !endpointsAgree || !ensOk ? "failed" : identityOk ? "verified" : "partial";
  const result: VerificationResult = {
    schemaVersion: "1.0.0",
    outcome,
    verifiedAt,
    deploymentId: d.deploymentId,
    chain: `eip155:${d.chainId}`,
    name: { input: intent.name.input, normalized: name, labelhash: intent.name.labelhash, namehash: namehash(name) },
    canonicality: { registryMatchesManifest: e.registryOk, observedRegistry: e.observedRegistry, universalResolver: d.universalResolver },
    ens: {
      registered,
      ...(e.whois?.owner ? { owner: e.whois.owner } : {}),
      expectedOwner: owner,
      ownerMatches: !!e.whois?.owner && isAddressEqual(e.whois.owner, owner),
      ...(e.resolver?.resolver ? { resolver: e.resolver.resolver } : {}),
      ...(e.forward ? { forwardAddress: getAddress(e.forward) } : {}),
      ...(addrRecord ? { forwardResolutionMatches: !!e.forward && isAddressEqual(getAddress(e.forward), getAddress(addrRecord.value)) } : {}),
      ...(e.whois ? { expiry: e.whois.expiry, currentTokenId: BigInt(e.whois.tokenId).toString() } : {}),
    },
    ...(identity ? { identity } : {}),
    checks,
    evidenceSource: { rpcEndpointCount: 2, endpointsAgree, blockNumber: Number(e.blockNumber), providerAssertionsUsed: false },
    ...(errors.length ? { errors } : {}),
    custody: { mode: "direct", transferRequired: false, transferCompleted: true, finalOwnerIsIntendedOwner: !!e.whois?.owner && isAddressEqual(e.whois.owner, owner) },
  };
  return result;
}
