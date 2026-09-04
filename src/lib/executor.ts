/**
 * Classification of what the wallet executor tells us, host-free so the
 * engine and the tests share one truth table.
 *
 * The real contract, read from @metamask/agent-wallet 6.2.0
 * (dist/chunks/cliWalletExecutor-*.js) and @metamask/fox-sdk:
 *
 *  - The executor RETURNS a result for CONFIRMED / BROADCASTED and for the two
 *    server-side tracking timeouts BROADCAST_TRACKING_EXPIRED and
 *    CONFIRMATION_TRACKING_EXPIRED, which fox-sdk documents as "status
 *    unknown, check on-chain". Those may come back without a hash.
 *  - It THROWS for FAILED / BROADCAST_FAILED / DENIED / EXPIRED, through
 *    mapTerminalJobFailure: a CommandError whose `code` is TX_DENIED,
 *    TX_EXPIRED (also used for the tracking timeouts on the polling path),
 *    TX_REVERTED (failureCode rpc_reverted) or TX_FAILED, carrying the
 *    terminal reason in `failureReason`.
 *  - A polling failure has the pending job attached: `error.pendingJob`
 *    with `pollingId`, the handle for `mm wallet requests watch`.
 *  - agent-sdk's waitForEvmReceipt throws code TX_REVERTED with the hash in
 *    the message: "Transaction 0x… reverted on chain 11155111."
 *
 * Only two outcomes are ever "nothing was broadcast": DENIED (the approval
 * was rejected before signing) and EXPIRED (the approval window lapsed).
 * Everything else that lacks a hash is UNKNOWN and the step must stay in
 * flight; a tracking timeout in particular means the transaction may well
 * land later.
 */
import type { Hex } from "viem";

export type SubmitResult = { hash?: Hex; status: string; failureCode?: string; failureDescription?: string; walletJobId?: string };

export type SubmitOutcome =
  /** A transaction hash exists. Its receipt decides success or revert. */
  | { kind: "hash"; hash: Hex; status: string; walletJobId?: string }
  /** Definitely not broadcast: the wallet refused before signing. Safe to attempt again on the next run. */
  | { kind: "not_broadcast"; code: "E_POLICY_DENIED" | "E_MFA_REQUIRED"; reason: string }
  /** The wallet reported a revert and named the hash; the receipt must still be read to confirm it. */
  | { kind: "reverted_hash"; hash: Hex; reason: string }
  /** Outcome unknown. The step stays in flight; the chain decides on the next run. */
  | { kind: "unknown"; reason: string; walletJobId?: string };

const HASH_RE = /0x[0-9a-fA-F]{64}/;

/** Shape of the host's EvmWalletResult we rely on; typed loosely so the SDK type can evolve. */
export type WalletResultLike = {
  kind: string;
  hash?: string;
  status: string;
  failureCode?: string;
  failureDescription?: string;
  pendingJob?: { pollingId?: string } | null;
};

/** Pure mapping of the host executor's returned result onto SubmitResult. `pendingJob.pollingId` is the wallet's job handle (PendingJobEntry). */
export function walletResultToSubmitResult(r: WalletResultLike): SubmitResult {
  if (r.kind !== "transaction") throw new Error("the wallet returned a non-transaction result");
  const pollingId = r.pendingJob?.pollingId;
  return {
    ...(r.hash ? { hash: r.hash as Hex } : {}),
    status: r.status,
    ...(r.failureCode ? { failureCode: r.failureCode } : {}),
    ...(r.failureDescription ? { failureDescription: r.failureDescription } : {}),
    ...(pollingId ? { walletJobId: pollingId } : {}),
  };
}

/** A returned result. Anything without a hash is unknown: the host never returns a definitely-not-broadcast status, it throws those. */
export function classifyReturned(r: SubmitResult): SubmitOutcome {
  if (r.hash && HASH_RE.test(r.hash)) return { kind: "hash", hash: r.hash, status: r.status, ...(r.walletJobId ? { walletJobId: r.walletJobId } : {}) };
  return { kind: "unknown", reason: `the wallet returned status ${r.status}${r.failureDescription ? ` (${r.failureDescription})` : r.failureCode ? ` (${r.failureCode})` : ""} without a transaction hash`, ...(r.walletJobId ? { walletJobId: r.walletJobId } : {}) };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A thrown error. Keys on the host's CommandError fields, never on prose alone. */
export function classifyThrown(e: unknown): SubmitOutcome {
  const err = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  const message = e instanceof Error ? e.message : String(e);
  const code = str(err.code);
  const reason = str(err.failureReason) ?? str(err.terminalStatus);
  const pending = err.pendingJob as { pollingId?: unknown } | undefined;
  const walletJobId = pending && typeof pending === "object" ? str(pending.pollingId) : undefined;
  const first = message.split("\n")[0]!;

  if (code === "TX_DENIED" || reason === "DENIED") {
    return { kind: "not_broadcast", code: "E_POLICY_DENIED", reason: `the approval was denied (${first})` };
  }
  if (code === "TX_EXPIRED" || reason === "EXPIRED") {
    // TX_EXPIRED also covers the tracking timeouts on the polling path; only a plain EXPIRED approval window is "nothing broadcast".
    const tracking = /TRACKING_EXPIRED/i.test(reason ?? "") || /TRACKING_EXPIRED/i.test(message);
    if (reason === "EXPIRED" && !tracking) return { kind: "not_broadcast", code: "E_MFA_REQUIRED", reason: `the approval window expired before signing (${first})` };
    return { kind: "unknown", reason: tracking ? `the wallet stopped tracking the transaction (${first})` : `the request expired with an unclear terminal reason (${first})`, ...(walletJobId ? { walletJobId } : {}) };
  }
  if (code === "TX_REVERTED" || /\breverted\b/i.test(first)) {
    const m = HASH_RE.exec(message);
    if (m) return { kind: "reverted_hash", hash: m[0] as Hex, reason: first };
    return { kind: "unknown", reason: `the wallet reported a revert without naming the transaction (${first})`, ...(walletJobId ? { walletJobId } : {}) };
  }
  return { kind: "unknown", reason: first, ...(walletJobId ? { walletJobId } : {}) };
}
