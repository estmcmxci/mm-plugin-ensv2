// Finding 2 / 3: the executor-outcome classifier against the host's real
// contract (agent-wallet 6.2.0 cliWalletExecutor, fox-sdk TX_JOB_STATUS,
// agent-sdk waitForEvmReceipt). See src/lib/executor.ts for the sources.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReturned, classifyThrown, walletResultToSubmitResult } from "../dist/lib/executor.js";

const HASH = `0x${"ab".repeat(32)}`;
const hostError = (code, message, failureReason, extra = {}) => Object.assign(new Error(message), { name: "CommandError", code, hint: "…", ...(failureReason ? { failureReason } : {}), ...extra });

test("F3: walletResultToSubmitResult reads pendingJob.pollingId (PendingJobEntry), not .id", () => {
  const r = walletResultToSubmitResult({ kind: "transaction", hash: HASH, status: "CONFIRMED", pendingJob: { pollingId: "wjob-7", kind: "evm.transaction", namespace: "eip155", submittedAt: "2026-09-04T00:00:00Z" } });
  assert.equal(r.walletJobId, "wjob-7");
  assert.equal(r.hash, HASH);
  assert.equal(walletResultToSubmitResult({ kind: "transaction", hash: HASH, status: "CONFIRMED", pendingJob: { id: "wrong-field" } }).walletJobId, undefined);
  assert.equal(walletResultToSubmitResult({ kind: "transaction", hash: HASH, status: "CONFIRMED" }).walletJobId, undefined);
  assert.throws(() => walletResultToSubmitResult({ kind: "signature", status: "CONFIRMED" }));
});

test("F1: a returned result without a hash is unknown, whatever its status", () => {
  for (const status of ["BROADCAST_TRACKING_EXPIRED", "CONFIRMATION_TRACKING_EXPIRED", "EXPIRED", "DENIED", "FAILED", "SOMETHING_NEW"]) {
    const o = classifyReturned({ status, walletJobId: "wjob-1" });
    assert.equal(o.kind, "unknown", status);
    assert.equal(o.walletJobId, "wjob-1");
  }
  assert.equal(classifyReturned({ hash: HASH, status: "CONFIRMED" }).kind, "hash");
  assert.equal(classifyReturned({ hash: "0x1234", status: "CONFIRMED" }).kind, "unknown", "a malformed hash is not a hash");
});

test("F2: TX_DENIED and a plain EXPIRED approval window are the only definitely-not-broadcast outcomes", () => {
  assert.deepEqual(classifyThrown(hostError("TX_DENIED", "The approval was denied.", "DENIED")), { kind: "not_broadcast", code: "E_POLICY_DENIED", reason: "the approval was denied (The approval was denied.)" });
  assert.equal(classifyThrown(hostError("TX_EXPIRED", "Transaction job ended in status EXPIRED.", "EXPIRED")).code, "E_MFA_REQUIRED");
  // failureReason DENIED on any code still counts.
  assert.equal(classifyThrown(hostError("WALLET_ERROR", "x", "DENIED")).code, "E_POLICY_DENIED");
});

test("F2: TX_EXPIRED carrying a tracking timeout is unknown, never 'nothing was sent'", () => {
  for (const reason of ["BROADCAST_TRACKING_EXPIRED", "CONFIRMATION_TRACKING_EXPIRED"]) {
    const o = classifyThrown(hostError("TX_EXPIRED", `Transaction job ended in status ${reason}.`, reason, { pendingJob: { pollingId: "wjob-9" } }));
    assert.equal(o.kind, "unknown", reason);
    assert.equal(o.walletJobId, "wjob-9");
  }
  // TX_EXPIRED with no failureReason at all: unknown (conservative).
  assert.equal(classifyThrown(hostError("TX_EXPIRED", "expired")).kind, "unknown");
});

test("F2: TX_REVERTED with the hash in the message yields the hash so the receipt can confirm the revert", () => {
  const o = classifyThrown(Object.assign(new Error(`Transaction ${HASH} reverted on chain 11155111.`), { code: "TX_REVERTED" }));
  assert.equal(o.kind, "reverted_hash");
  assert.equal(o.hash, HASH);
  assert.equal(classifyThrown(hostError("TX_REVERTED", "reverted", "rpc_reverted")).kind, "unknown", "no hash → unknown");
});

test("F2: anything else thrown is unknown and carries pendingJob.pollingId when present", () => {
  const o = classifyThrown(Object.assign(new Error("pollUntilTerminal aborted"), { pendingJob: { pollingId: "wjob-3", kind: "evm.transaction" } }));
  assert.equal(o.kind, "unknown");
  assert.equal(o.walletJobId, "wjob-3");
  assert.equal(classifyThrown(new Error("Remote signing request failed (network error)")).kind, "unknown");
  assert.equal(classifyThrown("boom").kind, "unknown");
  assert.equal(classifyThrown(hostError("TX_FAILED", "Transaction job ended in status FAILED.", "FAILED")).kind, "unknown", "FAILED may be post-broadcast; never assume nothing was sent");
});
