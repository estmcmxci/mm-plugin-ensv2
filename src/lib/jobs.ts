/**
 * Durable job records (v0.6).
 *
 * One file per job at ~/.mm-plugin-ensv2/jobs/<jobId>.json, mode 0600. The
 * file wraps two things:
 *
 *   job      — a provisioning-job 1.0.0 record, validated against the frozen
 *              schema on every write. This is what `jobs show` prints and what
 *              the program's verifier and integration suite consume.
 *   private  — the commit/reveal tuple INCLUDING THE SECRET. The schema
 *              forbids a secret inside the record (noSecrets, D-011) and only
 *              admits a `commitmentSecretRef` handle, so the secret lives in
 *              this private section, the record points at it by ref, and
 *              `jobs show` redacts it. The secret is not a key and cannot move
 *              funds, but it is the only thing that lets a commitment be
 *              completed, so it is never printed or logged.
 *
 * This supersedes the v0.3 checkpoint in pending.ts: the register step's
 * tuple now lives inside the job, and `ensv2 register` runs as a job too.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { ProvisioningIntent } from "./intent.js";
import { SCHEMA_IDS, assertValid } from "./schema.js";

// ---------------------------------------------------------------------------
// Program types (shapes of provisioning-job / step-receipt / errors 1.0.0)

export type StepName =
  | "canonicality_check"
  | "name_validate"
  | "quote"
  | "intent_sign"
  | "payment_authorize"
  | "funding_preflight"
  | "resolver_deploy"
  | "resolver_initialize"
  | "payment_settle"
  | "payment_token_approve"
  | "commitment_submit"
  | "commitment_wait"
  | "price_recheck"
  | "registration_submit"
  | "renewal_submit"
  | "records_configure"
  | "roles_configure"
  | "ens_verify"
  | "identity_preflight"
  | "identity_bind"
  | "identity_metadata_publish"
  | "identity_verify"
  | "ownership_transfer"
  | "reverse_record_set";

/** step-receipt's stepName enum (a subset of the job's step enum): the steps that can carry a transaction. */
export type ReceiptStepName =
  | "resolver_deploy"
  | "resolver_initialize"
  | "payment_token_approve"
  | "commitment_submit"
  | "registration_submit"
  | "records_configure"
  | "roles_configure"
  | "identity_bind"
  | "identity_metadata_publish"
  | "ownership_transfer"
  | "reverse_record_set"
  | "intent_sign"
  | "payment_authorize"
  | "renewal_submit";

export type StepState = "pending" | "in_progress" | "succeeded" | "failed" | "skipped";

export type JobState =
  | "draft"
  | "quoted"
  | "awaiting_authorization"
  | "payment_pending"
  | "direct_funding_ready"
  | "accepted"
  | "resolver_prepared"
  | "commitment_submitted"
  | "commitment_confirmed"
  | "commitment_maturing"
  | "registration_submitted"
  | "ens_registered"
  | "identity_pending"
  | "identity_bound"
  | "completed"
  | "retryable_failed"
  | "terminal_failed"
  | "expired"
  | "cancelled";

export type ErrorCode =
  | "E_DEPLOYMENT_DRIFT"
  | "E_UNSUPPORTED_DEPLOYMENT"
  | "E_UNSUPPORTED_NETWORK"
  | "E_NAME_INVALID"
  | "E_NAME_UNAVAILABLE"
  | "E_DURATION_OUT_OF_BOUNDS"
  | "E_PRICE_EXCEEDS_MAX_SPEND"
  | "E_QUOTE_EXPIRED"
  | "E_INSUFFICIENT_FUNDS"
  | "E_INSUFFICIENT_ALLOWANCE"
  | "E_COMMITMENT_TOO_YOUNG"
  | "E_COMMITMENT_EXPIRED"
  | "E_COMMITMENT_SECRET_UNAVAILABLE"
  | "E_RESOLVER_NOT_PREPARED"
  | "E_TRANSACTION_REVERTED"
  | "E_RECEIPT_STATUS_FAILED"
  | "E_RECEIPT_UNAVAILABLE"
  | "E_RENEWAL_FAILED"
  | "E_VERIFICATION_MISMATCH"
  | "E_RPC_DISAGREEMENT"
  | "E_INTENT_EXPIRED"
  | "E_INTENT_SIGNATURE_INVALID"
  | "E_INTENT_REPLAY"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_PAYMENT_REQUIRED"
  | "E_PAYMENT_REJECTED"
  | "E_PAYMENT_SETTLEMENT_UNKNOWN"
  | "E_PAYMENT_ALREADY_SETTLED"
  | "E_PROVIDER_UNAVAILABLE"
  | "E_PROVIDER_RESPONSE_UNTRUSTED"
  | "E_PROVIDER_CAPABILITY_UNSUPPORTED"
  | "E_CUSTODY_MODE_UNSUPPORTED"
  | "E_IDENTITY_ADAPTER_UNAVAILABLE"
  | "E_IDENTITY_BINDING_FAILED"
  | "E_IDENTITY_TOKEN_ID_STALE"
  | "E_IDENTITY_METADATA_FAILED"
  | "E_CUSTODY_TRANSFER_INCOMPLETE"
  | "E_IDENTITY_BINDING_ORPHANED"
  | "E_POLICY_DENIED"
  | "E_MFA_REQUIRED"
  | "E_JOB_NOT_FOUND"
  | "E_JOB_TERMINAL"
  | "E_INTERNAL";

export type ErrorCategory = "validation" | "deployment" | "funding" | "policy" | "network" | "provider" | "payment" | "ens" | "identity" | "internal";
export type Retryability = "retryable" | "terminal" | "requires_user_action" | "indeterminate";
export type RecoveryKind =
  | "none"
  | "retry_same_step"
  | "resume_job"
  | "refresh_quote_and_resume"
  | "fund_wallet_and_resume"
  | "grant_allowance_and_resume"
  | "await_commitment_age"
  | "inspect_settlement_before_any_retry"
  | "inspect_job_status"
  | "resume_identity_only"
  | "reregister_identity"
  | "reauthorize_intent"
  | "manual_intervention"
  | "abandon_job";

export type ProgramError = {
  code: ErrorCode;
  category: ErrorCategory;
  retryability: Retryability;
  message: string;
  occurredAt: string;
  step?: StepName;
  recoveryAction: { kind: RecoveryKind; description: string; resumeFrom?: string; notBefore?: string };
  evidence?: { transactionHashes?: Hex[]; jobId?: string; intentHash?: Hex; deploymentId?: string; revertConfirmed?: boolean };
  details?: Record<string, unknown>;
  source?: "wallet" | "provider" | "verifier" | "protocol" | "unknown";
};

export type TransactionReceiptRecord = {
  kind: "transaction";
  chain: `eip155:${number}`;
  deploymentId: string;
  step: ReceiptStepName;
  transactionHash: Hex;
  receiptStatus: "success" | "reverted" | "unknown";
  blockNumber?: number;
  blockHash?: Hex;
  from?: Address;
  to?: Address;
  gasUsed?: string;
  effectiveGasPrice?: string;
  submittedAt: string;
  confirmedAt?: string;
  attempt?: number;
  walletJobId?: string;
};

export type JobStep = {
  step: StepName;
  state: StepState;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  receipts?: TransactionReceiptRecord[];
  error?: ProgramError;
};

export type IdentityAnchor = { kind: "resource" | "token-id"; value: string; observedAt: string };

export type JobFacts = {
  normalizedName: string;
  labelhash?: Hex;
  owner: Address;
  durationSeconds?: number;
  commitmentSecretRef?: string;
  commitmentHash?: Hex;
  commitmentSubmittedAt?: string;
  commitmentMatureAt?: string;
  commitmentExpiresAt?: string;
  resolverAddress?: Address;
  currentTokenId?: string;
  erc8004AgentId?: string;
  attemptCounters?: Record<string, number>;
  executionPlane?: { kind: string; ref: string };
  identityAnchor?: IdentityAnchor;
};

export type VerificationCheck = { id: string; description?: string; expected?: string | number | boolean | null; actual?: string | number | boolean | null; passed: boolean; severity?: "required" | "advisory" };

export type VerificationResult = {
  schemaVersion: "1.0.0";
  outcome: "verified" | "partial" | "failed";
  verifiedAt: string;
  deploymentId: string;
  chain: `eip155:${number}`;
  name: { input?: string; normalized: string; labelhash?: Hex; namehash?: Hex };
  canonicality: { registryMatchesManifest: boolean; observedRegistry: Address; universalResolver?: Address };
  ens: {
    registered: boolean;
    owner?: Address;
    expectedOwner?: Address;
    ownerMatches?: boolean;
    resolver?: Address;
    forwardAddress?: Address;
    forwardResolutionMatches?: boolean;
    expiry?: number;
    currentTokenId?: string;
  };
  identity?: {
    requested: "erc8004";
    bound: boolean;
    agentId?: string;
    adapterProxy?: Address;
    adapterImplementation?: Address;
    boundTokenId?: string;
    boundTokenIdIsCurrent?: boolean;
    controlVerified?: boolean;
    agentUri?: string;
    ensipRecordsPublished?: boolean;
    anchor?: { kind: "resource" | "token-id" | "labelhash"; value: string; invariantUnderTokenIdChange?: boolean; survivesReregistration?: boolean; epochEqualityChecked?: boolean };
    bindingStandard?: "erc721";
    bindingStandardId?: number;
    bindingMetadataAddress?: Address;
    bindingMetadataMatches?: boolean;
    ownerCheckMethod?: "getOwner" | "ownerOf-getTokenId";
  };
  checks: VerificationCheck[];
  evidenceSource: { rpcEndpointCount: number; endpointsAgree: boolean; blockNumber?: number; providerAssertionsUsed: false };
  errors?: ProgramError[];
  custody: { mode: "direct"; transferRequired: false; transferCompleted: boolean; finalOwnerIsIntendedOwner?: boolean };
};

export type JobRecord = {
  schemaVersion: "1.0.0";
  jobId: string;
  origin: "local";
  state: JobState;
  intentHash: Hex;
  idempotencyKey: Hex;
  deploymentId: string;
  chain: `eip155:${number}`;
  payment: "direct";
  identity: "none" | "erc8004";
  custodyMode: "direct";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  facts: JobFacts;
  steps: JobStep[];
  outcome?: { ens?: "pending" | "succeeded" | "failed"; identity?: "not_requested" | "pending" | "succeeded" | "failed"; payment?: "not_required" | "pending" | "settled" | "unknown" | "rejected" };
  resume?: { resumable: boolean; resumeFromStep?: Exclude<StepName, "identity_bind">; nextAction?: string; blockedBy?: ProgramError; notBefore?: string; requiresPayment?: boolean };
  result?: { verification: VerificationResult; name?: string; owner?: Address; transactionHashes?: Hex[] };
  errors?: ProgramError[];
};

// ---------------------------------------------------------------------------
// The on-disk file

export const JOB_FILE_FORMAT = "mm-plugin-ensv2/job@1";

/** The commit/reveal tuple. Private: never printed, never logged, never validated INTO the record. */
export type PrivateCommitment = {
  label: string;
  owner: Address;
  secret: Hex;
  subregistry: Address;
  resolver: Address;
  durationSeconds: number;
  referrer: Hex;
  commitment: Hex;
};

export type JobFile = {
  format: typeof JOB_FILE_FORMAT;
  /** The program-shaped intent this job executes. Recomputed and checked on load. */
  intent: ProvisioningIntent;
  job: JobRecord;
  private: { commitment: PrivateCommitment | null };
};

export const commitmentSecretRef = (jobId: string) => `ref:mm-plugin-ensv2:job:${jobId}:commitment`;

/** Validate everything in the file that is a program artifact. Throws SchemaViolation. */
export function validateJobFile(file: JobFile): void {
  assertValid(SCHEMA_IDS.intent, file.intent, `intent for job ${file.job.jobId}`);
  for (const s of file.job.steps) {
    for (const r of s.receipts ?? []) assertValid(SCHEMA_IDS.stepReceipt, r, `receipt on step ${s.step}`);
    if (s.error) assertValid(SCHEMA_IDS.errors, s.error, `error on step ${s.step}`);
  }
  if (file.job.result) assertValid(SCHEMA_IDS.verificationResult, file.job.result.verification, `verification result of job ${file.job.jobId}`);
  for (const e of file.job.errors ?? []) assertValid(SCHEMA_IDS.errors, e, `job error`);
  if (file.job.resume?.blockedBy) assertValid(SCHEMA_IDS.errors, file.job.resume.blockedBy, `resume.blockedBy`);
  assertValid(SCHEMA_IDS.job, file.job, `job ${file.job.jobId}`);
  // Belt and braces: the secret must never be reachable through the record.
  const text = JSON.stringify(file.job);
  if (file.private.commitment && text.includes(file.private.commitment.secret.slice(2, 18))) {
    throw new Error("refusing to write: the commitment secret leaked into the job record");
  }
}

/** What `jobs show` prints: the record intact, the private section reduced to a handle. */
export function redactJobFile(file: JobFile): { format: string; intent: ProvisioningIntent; job: JobRecord; private: { commitment: Omit<PrivateCommitment, "secret"> & { secret: "<redacted>" } | null } } {
  const c = file.private.commitment;
  return { format: file.format, intent: file.intent, job: file.job, private: { commitment: c ? { ...c, secret: "<redacted>" } : null } };
}

// ---------------------------------------------------------------------------
// Stores

export interface JobStore {
  get(jobId: string): Promise<JobFile | null>;
  /** Validates, then persists atomically. */
  put(file: JobFile): Promise<void>;
  list(): Promise<JobFile[]>;
  /** Human-readable location for messages; null when not file-backed. */
  location(jobId: string): string | null;
}

export class MemoryJobStore implements JobStore {
  private readonly files = new Map<string, string>();
  async get(jobId: string): Promise<JobFile | null> {
    const raw = this.files.get(jobId);
    return raw ? (JSON.parse(raw) as JobFile) : null;
  }
  async put(file: JobFile): Promise<void> {
    validateJobFile(file);
    this.files.set(file.job.jobId, JSON.stringify(file));
  }
  async list(): Promise<JobFile[]> {
    return [...this.files.values()].map((raw) => JSON.parse(raw) as JobFile);
  }
  location(): null {
    return null;
  }
}

export const DEFAULT_JOBS_DIR = join(homedir(), ".mm-plugin-ensv2", "jobs");

const JOB_ID_RE = /^[a-z0-9][a-z0-9._-]{0,255}$/;

export class FileJobStore implements JobStore {
  constructor(readonly dir: string = DEFAULT_JOBS_DIR) {}

  location(jobId: string): string {
    return join(this.dir, `${jobId}.json`);
  }

  async get(jobId: string): Promise<JobFile | null> {
    if (!JOB_ID_RE.test(jobId)) return null;
    const p = this.location(jobId);
    if (!existsSync(p)) return null;
    const file = JSON.parse(readFileSync(p, "utf8")) as JobFile;
    if (file.format !== JOB_FILE_FORMAT) throw new Error(`${p}: unknown job file format ${String((file as { format?: unknown }).format)}`);
    return file;
  }

  async put(file: JobFile): Promise<void> {
    validateJobFile(file);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = this.location(file.job.jobId);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  }

  async list(): Promise<JobFile[]> {
    if (!existsSync(this.dir)) return [];
    const out: JobFile[] = [];
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const file = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as JobFile;
        if (file.format === JOB_FILE_FORMAT) out.push(file);
      } catch {
        /* skip unreadable files; `jobs show` on the id reports the parse error */
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Record helpers

export const nowIso = (d: Date = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function findStep(job: JobRecord, name: StepName): JobStep | undefined {
  return job.steps.find((s) => s.step === name);
}

/** Insert-or-update a step entry, preserving order of first appearance. */
export function upsertStep(job: JobRecord, name: StepName, patch: Partial<Omit<JobStep, "step">>): JobStep {
  let s = findStep(job, name);
  if (!s) {
    s = { step: name, state: "pending" };
    job.steps.push(s);
  }
  Object.assign(s, patch);
  return s;
}

export function programError(e: Omit<ProgramError, "occurredAt"> & { occurredAt?: string }): ProgramError {
  return { occurredAt: nowIso(), ...e };
}

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["completed", "terminal_failed", "expired", "cancelled"]);

/** Every transaction hash recorded on the job, in step order. */
export function transactionHashes(job: JobRecord): Hex[] {
  const out: Hex[] = [];
  for (const s of job.steps) for (const r of s.receipts ?? []) if (r.receiptStatus === "success" && !out.includes(r.transactionHash)) out.push(r.transactionHash);
  return out;
}
