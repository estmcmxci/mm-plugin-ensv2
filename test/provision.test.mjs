// The interruption matrix and the idempotency rules of the v0.6 job engine,
// run against an in-memory chain (test/mock-chain.mjs) and a killable wallet.
//
// Every row: run the job, kill the process at the named point, start a fresh
// run against the same store, and assert (a) the killed step was not sent
// again, (b) it was recovered from chain evidence, (c) the job completed with
// a schema-valid record whose verification passed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SEPOLIA } from "../dist/lib/deployments.js";
import { MemoryJobStore, redactJobFile, validateJobFile } from "../dist/lib/jobs.js";
import { ProvisionHalt, adoptLegacyCommitment, desiredRecords, jobsFor, observeJob, planProvision, runJob, stepsFor } from "../dist/lib/provision.js";
import { SCHEMA_IDS, validateSchema } from "../dist/lib/schema.js";
import { MockChain, mockExecutor, secondEndpoint } from "./mock-chain.mjs";

const OWNER = "0x00000000000000000000000000000000000000A1";
const STRANGER = "0x00000000000000000000000000000000000000B2";
const AGENT_URI = "https://agent.example/agent.json";

const request = (over = {}) => ({
  input: "Durable",
  owner: OWNER,
  durationSeconds: 31536000n,
  identity: { agentUri: AGENT_URI },
  records: { addr: OWNER, texts: { description: "A durable agent", url: "https://agent.example", "agent-endpoint[web]": "https://agent.example", "agent-context": "# durable.eth\n" } },
  resolverMode: "deploy-owned",
  ...over,
});

function world(opts = {}) {
  const chain = new MockChain();
  chain.fund(OWNER, 100_000_000n);
  const store = new MemoryJobStore();
  const deps = (exec, extra = {}) => ({
    chain,
    verifyChain: extra.verifyChain ?? chain,
    deployment: SEPOLIA,
    submit: exec.submit,
    store,
    now: () => new Date(chain.time * 1000),
    sleep: async (ms) => {
      chain.time += Math.max(1, Math.ceil(ms / 1000));
      chain.block += 1n;
    },
    log: opts.log ?? (() => {}),
    progress: () => {},
  });
  return { chain, store, deps };
}

/** Plan and persist a new job (or return the existing one). */
async function startJob(w, req = request()) {
  const plan = await planProvision({ chain: w.chain, deployment: SEPOLIA, store: w.store }, req);
  if (plan.kind === "new") await w.store.put(plan.file);
  return plan;
}

async function expectHalt(p) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProvisionHalt) return e;
    throw e;
  }
  assert.fail("expected the job to halt");
}

function assertCompleted(file, { identity = true } = {}) {
  assert.equal(file.job.state, "completed");
  assert.equal(file.job.result.verification.outcome, "verified");
  assert.equal(file.job.outcome.ens, "succeeded");
  if (identity) {
    assert.equal(file.job.outcome.identity, "succeeded");
    assert.ok(file.job.facts.erc8004AgentId);
    assert.equal(file.job.result.verification.identity.bound, true);
    assert.equal(file.job.result.verification.identity.ensipRecordsPublished, true);
  }
  validateJobFile(file);
  assert.ok(validateSchema(SCHEMA_IDS.job, file.job).ok);
  assert.ok(validateSchema(SCHEMA_IDS.verificationResult, file.job.result.verification).ok);
}

const count = (arr, step) => arr.filter((s) => s === step).length;

// ---------------------------------------------------------------------------

test("happy path: one job runs every step once and completes verified", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  assert.equal(plan.kind, "new");
  const file = await runJob(w.deps(exec), plan.file);
  assertCompleted(file);
  assert.deepEqual(exec.calls, ["resolver_deploy", "commitment_submit", "payment_token_approve", "registration_submit", "identity_bind", "records_configure"]);
  assert.equal(w.chain.agents.length, 1);
  assert.equal(w.chain.applied.filter((t) => t.status === "reverted").length, 0);
  // Receipts: one success receipt per transaction step, none unknown.
  for (const s of file.job.steps) for (const r of s.receipts ?? []) assert.equal(r.receiptStatus, "success");
  assert.equal(file.job.result.transactionHashes.length, 6);
  // The secret never reaches the record, and jobs show redacts it.
  const secret = file.private.commitment.secret;
  assert.ok(!JSON.stringify(file.job).includes(secret.slice(2)));
  assert.equal(redactJobFile(file).private.commitment.secret, "<redacted>");
  assert.ok(!JSON.stringify(redactJobFile(file)).includes(secret.slice(2)));
});

// ---------------------------------------------------------------------------
// Interruption matrix: kill immediately AFTER each irreversible step landed.

const IRREVERSIBLE = [
  ["resolver_deploy", (c) => c.resolvers.size === 1, "resolver code exists at the predicted address and is factory-attested"],
  ["commitment_submit", (c) => c.commitments.size === 1, "commitmentAt(commitment) is non-zero and inside the 24 h window"],
  ["payment_token_approve", (c) => [...c.allowances.values()].some((a) => a > 0n), "allowance for the registrar covers the ceiling"],
  ["registration_submit", (c) => c.entry("durable")?.owner === OWNER, "registry reports REGISTERED to the owner; anchor recorded"],
  ["identity_bind", (c) => c.agents.length === 1, "AgentBound scan finds one agent bound to the current token, registered by the owner"],
  ["records_configure", (c) => c.records.size === 1, "every intended record reads back through the Universal Resolver; diff is empty"],
];

export const matrixRows = [];

for (const [step, landed, observed] of IRREVERSIBLE) {
  test(`kill after ${step} landed → resume skips it, sends nothing for it, completes`, async () => {
    const w = world();
    const first = mockExecutor(w.chain, OWNER, { killAfter: step });
    const plan = await startJob(w);
    const jobId = plan.file.job.jobId;
    const frozen = runJob(w.deps(first), plan.file);
    frozen.catch(() => {});
    await first.reached;
    assert.ok(landed(w.chain), `${step} should have landed on chain before the kill`);

    // The store shows the step in flight with no outcome, exactly as a crash leaves it.
    const onDisk = await w.store.get(jobId);
    const rec = onDisk.job.steps.find((s) => s.step === step);
    assert.equal(rec.state, "in_progress");
    assert.ok(!(rec.receipts ?? []).length, "no receipt was recorded before the kill");

    const second = mockExecutor(w.chain, OWNER);
    const file = await runJob(w.deps(second), onDisk);
    assertCompleted(file);
    assert.equal(count(second.calls, step), 0, `resume must not resend ${step}`);
    assert.equal(count(first.calls, step), 1);
    const done = file.job.steps.find((s) => s.step === step);
    assert.equal(done.state, "succeeded");
    assert.equal(done.attempts, 1);
    assert.equal(w.chain.agents.length, 1, "exactly one agent minted");
    assert.equal(w.chain.applied.filter((t) => t.fn === "register").length, 1, "exactly one registration paid");
    matrixRows.push({ step, killPoint: "after the transaction landed, before the job file was updated", observed, action: "step marked succeeded from chain evidence; not resent", submissions: second.calls.filter((s) => s === step).length, result: "completed, verified" });
  });
}

// ---------------------------------------------------------------------------
// Submitted-but-unknown: the process dies (or the wallet errors) with no evidence on chain.

for (const step of ["registration_submit", "identity_bind"]) {
  test(`kill before ${step} was broadcast → resume halts as indeterminate; --resubmit-unconfirmed sends it once`, async () => {
    const w = world();
    const first = mockExecutor(w.chain, OWNER, { killBefore: step });
    const plan = await startJob(w);
    const frozen = runJob(w.deps(first), plan.file);
    frozen.catch(() => {});
    await first.reached;

    const second = mockExecutor(w.chain, OWNER);
    const halt = await expectHalt(runJob(w.deps(second), await w.store.get(plan.file.job.jobId)));
    assert.equal(halt.error.retryability, "indeterminate");
    assert.equal(halt.error.recoveryAction.kind, "inspect_job_status");
    assert.equal(halt.error.code, step === "identity_bind" ? "E_IDENTITY_BINDING_FAILED" : "E_RECEIPT_UNAVAILABLE");
    assert.match(halt.error.recoveryAction.description, /--resubmit-unconfirmed/);
    assert.equal(count(second.calls, step), 0, "an indeterminate step is never resent automatically");
    assert.ok(validateSchema(SCHEMA_IDS.errors, halt.error).ok, "the halt error is a valid program error");
    assert.equal(halt.file.job.state, "retryable_failed");
    assert.equal(halt.file.job.resume.resumable, true);
    assert.equal(halt.file.job.resume.blockedBy.code, halt.error.code);
    assert.notEqual(halt.file.job.resume.resumeFromStep, "identity_bind", "D-010: never resume directly into identity_bind");

    // Running again without the flag halts again, still without sending.
    const third = mockExecutor(w.chain, OWNER);
    const again = await expectHalt(runJob(w.deps(third), await w.store.get(plan.file.job.jobId)));
    assert.equal(again.error.code, halt.error.code);
    assert.equal(count(third.calls, step), 0);

    // The user checked; nothing landed. Explicit override sends it exactly once.
    const fourth = mockExecutor(w.chain, OWNER);
    const file = await runJob(w.deps(fourth), await w.store.get(plan.file.job.jobId), { resubmitUnconfirmed: true });
    assertCompleted(file);
    assert.equal(count(fourth.calls, step), 1);
    assert.equal(w.chain.agents.length, 1);
    matrixRows.push({ step, killPoint: "after the wallet request began, before anything was broadcast", observed: "no evidence on chain for the step", action: `halted ${halt.error.code} (indeterminate); resent only under --resubmit-unconfirmed`, submissions: 0, result: "halted, then completed after explicit override" });
  });
}

test("live case: approve landed, then the wallet errored (network drop) → first run halts; resume observes the allowance and skips", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { throwAfter: "payment_token_approve" });
  const plan = await startJob(w);
  const halt = await expectHalt(runJob(w.deps(first), plan.file));
  assert.equal(halt.error.code, "E_RECEIPT_UNAVAILABLE");
  assert.equal(halt.error.retryability, "indeterminate");
  assert.match(halt.error.message, /Remote signing request failed/);
  const stepRec = halt.file.job.steps.find((s) => s.step === "payment_token_approve");
  assert.equal(stepRec.state, "in_progress");

  const second = mockExecutor(w.chain, OWNER);
  const file = await runJob(w.deps(second), await w.store.get(plan.file.job.jobId));
  assertCompleted(file);
  assert.equal(count(second.calls, "payment_token_approve"), 0);
  assert.equal(count(second.calls, "commitment_submit"), 0, "the commit that landed before the drop is not resent either");
  assert.equal(w.chain.applied.filter((t) => t.fn === "approve").length, 1);
  matrixRows.push({ step: "payment_token_approve", killPoint: "transaction landed, then the wallet executor threw (network drop while polling)", observed: "allowance for the registrar already covers the ceiling", action: "first run halted E_RECEIPT_UNAVAILABLE; resume skipped the step", submissions: 0, result: "completed, verified" });
});

test("kill during commitment_wait → resume waits out the remaining age and never re-commits", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killBefore: "registration_submit" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  // Rewind the recorded state to "still maturing" by loading the file as of the wait: the commit landed, register was never sent.
  const onDisk = await w.store.get(plan.file.job.jobId);
  const reg = onDisk.job.steps.find((s) => s.step === "registration_submit");
  reg.state = "pending"; // as if the crash happened in the wait loop, before register began
  onDisk.job.steps.find((s) => s.step === "commitment_wait").state = "in_progress";
  await w.store.put(onDisk);
  const second = mockExecutor(w.chain, OWNER);
  const file = await runJob(w.deps(second), onDisk);
  assertCompleted(file);
  assert.equal(count(second.calls, "commitment_submit"), 0);
  assert.equal(w.chain.applied.filter((t) => t.fn === "commit").length, 1);
});

// ---------------------------------------------------------------------------
// Idempotency

test("duplicate invocation with the same inputs is a no-op: same job, nothing sent", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  await runJob(w.deps(exec), plan.file);
  const again = await planProvision({ chain: w.chain, deployment: SEPOLIA, store: w.store }, request());
  assert.equal(again.kind, "existing");
  assert.equal(again.inputsMatch, true);
  assert.equal(again.file.job.jobId, plan.file.job.jobId);
  const exec2 = mockExecutor(w.chain, OWNER);
  const file = await runJob(w.deps(exec2), again.file);
  assert.equal(file.job.state, "completed");
  assert.deepEqual(exec2.calls, []);
});

test("job id is deterministic in (chain, name, owner, intent hash) and independent of the secret", async () => {
  const a = world();
  const b = world();
  const pa = await startJob(a);
  const pb = await startJob(b);
  assert.equal(pa.file.job.jobId, pb.file.job.jobId);
  assert.equal(pa.file.intent.eip712.intentHash, pb.file.intent.eip712.intentHash);
  assert.equal(pa.file.job.intentHash, pa.file.job.idempotencyKey);
  assert.notEqual(pa.file.private.commitment.secret, pb.file.private.commitment.secret);
  assert.match(pa.file.job.jobId, /^[0-9a-f]{32}$/);
  assert.equal(pa.file.job.facts.commitmentSecretRef, `ref:mm-plugin-ensv2:job:${pa.file.job.jobId}:commitment`);
  // Different inputs, different job.
  const c = world();
  const pc = await startJob(c, request({ durationSeconds: 63072000n }));
  assert.notEqual(pc.file.job.jobId, pa.file.job.jobId);
});

test("a second provision for the same name with different inputs is refused while a job exists", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killAfter: "commitment_submit" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  const other = await planProvision({ chain: w.chain, deployment: SEPOLIA, store: w.store }, request({ durationSeconds: 63072000n }));
  assert.equal(other.kind, "existing");
  assert.equal(other.inputsMatch, false);
  assert.equal(other.conflict.code, "E_IDEMPOTENCY_CONFLICT");
  assert.ok(validateSchema(SCHEMA_IDS.errors, other.conflict).ok);
  assert.equal((await jobsFor(w.store, SEPOLIA.chainId, "durable.eth", OWNER)).length, 1);
});

test("the intent is schema-valid, direct-custody, and pins the adapter implementation", async () => {
  const w = world();
  const plan = await startJob(w);
  const i = plan.file.intent;
  assert.ok(validateSchema(SCHEMA_IDS.intent, i).ok, validateSchema(SCHEMA_IDS.intent, i).errors.join("; "));
  assert.equal(i.payment, "direct");
  assert.equal(i.custodyMode, "direct");
  assert.equal(i.identity, "erc8004");
  assert.equal(i.identityConfig.adapterImplementation, w.chain.adapterImpl);
  assert.equal(i.identityConfig.anchorKind, "token-id");
  assert.equal(i.identityConfig.bindingStandard, "erc721");
  assert.equal(i.resolverConfig.mode, "deploy-owned");
  assert.equal(i.name.normalized, "durable.eth");
  assert.equal(i.name.input, "Durable");
  assert.equal(i.maxSpend.maxTotalAmount, w.chain.price.toString());
  assert.deepEqual(stepsFor(i), ["canonicality_check", "resolver_deploy", "commitment_submit", "payment_token_approve", "commitment_wait", "price_recheck", "registration_submit", "identity_preflight", "identity_bind", "identity_verify", "records_configure", "ens_verify"]);
});

// ---------------------------------------------------------------------------
// Guards that stop a paid step

test("price above the intent's ceiling halts before register; nothing paid", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killAfter: "commitment_submit" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  w.chain.price = w.chain.price * 2n;
  const second = mockExecutor(w.chain, OWNER);
  const halt = await expectHalt(runJob(w.deps(second), await w.store.get(plan.file.job.jobId)));
  assert.equal(halt.error.code, "E_PRICE_EXCEEDS_MAX_SPEND");
  assert.equal(halt.error.retryability, "requires_user_action");
  assert.equal(count(second.calls, "registration_submit"), 0);
  assert.equal(w.chain.applied.filter((t) => t.fn === "register").length, 0);
});

test("an expired commitment is re-committed once on resume, then registration proceeds", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killAfter: "commitment_submit" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  w.chain.time += w.chain.maxAge + 10;
  const second = mockExecutor(w.chain, OWNER);
  const file = await runJob(w.deps(second), await w.store.get(plan.file.job.jobId));
  assertCompleted(file);
  assert.equal(count(second.calls, "commitment_submit"), 1);
  assert.equal(file.job.steps.find((s) => s.step === "commitment_submit").attempts, 2);
  assert.equal(w.chain.applied.filter((t) => t.fn === "register").length, 1);
});

test("a confirmed revert marks the step failed/retryable and is retried only by the next run", async () => {
  const w = world();
  const plan = await startJob(w);
  // Make the first register revert by draining the allowance behind the engine's back after approve.
  const exec = mockExecutor(w.chain, OWNER);
  const original = exec.submit;
  let drained = false;
  const submit = async (req) => {
    if (req.step === "registration_submit" && !drained) {
      drained = true;
      w.chain.allowances.set(OWNER.toLowerCase(), 0n);
    }
    return original(req);
  };
  const halt = await expectHalt(runJob({ ...w.deps(exec), submit }, plan.file));
  assert.equal(halt.error.code, "E_TRANSACTION_REVERTED");
  assert.equal(halt.error.retryability, "retryable");
  assert.equal(halt.error.evidence.revertConfirmed, true);
  assert.equal(count(exec.calls, "registration_submit"), 1, "no in-run retry");
  const rec = halt.file.job.steps.find((s) => s.step === "registration_submit");
  assert.equal(rec.state, "failed");
  assert.equal(rec.receipts[0].receiptStatus, "reverted");
  assert.equal(w.chain.entry("durable"), null);

  const second = mockExecutor(w.chain, OWNER);
  const file = await runJob(w.deps(second), await w.store.get(plan.file.job.jobId));
  assertCompleted(file);
  assert.deepEqual(second.calls, ["payment_token_approve", "registration_submit", "identity_bind", "records_configure"]);
});

test("name taken by someone else mid-job is terminal; nothing paid", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killAfter: "commitment_submit" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  w.chain.names.set("durable", { owner: STRANGER, expiry: w.chain.time + 10_000_000, version: 0, epoch: 1, resolver: null });
  const second = mockExecutor(w.chain, OWNER);
  const halt = await expectHalt(runJob(w.deps(second), await w.store.get(plan.file.job.jobId)));
  assert.equal(halt.error.code, "E_NAME_UNAVAILABLE");
  assert.equal(halt.error.retryability, "terminal");
  assert.equal(halt.file.job.state, "terminal_failed");
  assert.equal(halt.file.job.resume.resumable, false);
  assert.equal(count(second.calls, "registration_submit"), 0);
  const third = mockExecutor(w.chain, OWNER);
  const again = await expectHalt(runJob(w.deps(third), await w.store.get(plan.file.job.jobId)));
  assert.equal(again.error.code, "E_JOB_TERMINAL");
  assert.deepEqual(third.calls, []);
});

// ---------------------------------------------------------------------------
// Identity rules (D-010)

test("a role change after bind orphans the binding: terminal, never re-minted by the job", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killAfter: "identity_bind" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  w.chain.grantRole("durable");
  const second = mockExecutor(w.chain, OWNER);
  const halt = await expectHalt(runJob(w.deps(second), await w.store.get(plan.file.job.jobId)));
  assert.equal(halt.error.code, "E_IDENTITY_BINDING_ORPHANED");
  assert.equal(halt.error.retryability, "terminal");
  assert.equal(halt.error.recoveryAction.kind, "reregister_identity");
  assert.equal(count(second.calls, "identity_bind"), 0);
  assert.equal(w.chain.agents.length, 1);
});

test("an agent already bound to the name (manual `agent register`) is reused, not duplicated", async () => {
  const w = world();
  // Pre-register the name and bind an agent outside the job.
  w.chain.resolvers.set(w.chain.predicted(OWNER).toLowerCase(), { owner: OWNER, verified: true });
  w.chain.names.set("durable", { owner: OWNER, expiry: w.chain.time + 31536000, version: 0, epoch: 1, resolver: w.chain.predicted(OWNER) });
  w.chain.agents.push({ agentId: 777n, standard: 0, tokenContract: SEPOLIA.registry, tokenId: w.chain.tokenIdOf("durable", w.chain.names.get("durable")), registeredBy: OWNER, uri: AGENT_URI });
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  assert.equal(plan.kind, "new");
  assert.equal(plan.alreadyRegistered, true);
  assert.equal(plan.file.intent.maxSpend.maxTotalAmount, "0");
  const file = await runJob(w.deps(exec), plan.file);
  assertCompleted(file);
  assert.equal(file.job.facts.erc8004AgentId, "777");
  assert.deepEqual(exec.calls, ["records_configure"]);
  assert.equal(w.chain.agents.length, 1);
  for (const s of ["resolver_deploy", "commitment_submit", "payment_token_approve", "commitment_wait", "price_recheck", "registration_submit", "identity_bind"]) {
    assert.equal(file.job.steps.find((x) => x.step === s).state, "skipped", `${s} should be skipped`);
  }
});

test("adapter implementation drift after the intent was created is terminal at identity_preflight", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killAfter: "registration_submit" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  w.chain.adapterImpl = "0x00000000000000000000000000000000000000Ae";
  const second = mockExecutor(w.chain, OWNER);
  const halt = await expectHalt(runJob(w.deps(second), await w.store.get(plan.file.job.jobId)));
  assert.equal(halt.error.code, "E_DEPLOYMENT_DRIFT");
  assert.equal(count(second.calls, "identity_bind"), 0);
  assert.equal(w.chain.agents.length, 0);
});

// ---------------------------------------------------------------------------
// Verification

test("disagreeing endpoints cannot produce a verified result", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  const liar = secondEndpoint(w.chain, { method: "whois", answer: (v) => ({ ...v, owner: STRANGER }) });
  const halt = await expectHalt(runJob(w.deps(exec, { verifyChain: liar }), plan.file));
  assert.equal(halt.error.code, "E_RPC_DISAGREEMENT");
  assert.equal(halt.error.retryability, "retryable");
  assert.equal(halt.file.job.result.verification.outcome, "failed");
  assert.equal(halt.file.job.result.verification.evidenceSource.endpointsAgree, false);
  assert.ok(validateSchema(SCHEMA_IDS.verificationResult, halt.file.job.result.verification).ok);
  // Everything on chain is done; a re-run with an honest second endpoint verifies without sending anything.
  const exec2 = mockExecutor(w.chain, OWNER);
  const file = await runJob(w.deps(exec2), await w.store.get(plan.file.job.jobId));
  assertCompleted(file);
  assert.deepEqual(exec2.calls, []);
});

test("fail-closed gate: an endpoint serving ENSv1 stops the job before any wallet request", async () => {
  const w = world();
  w.chain.v2Active = false;
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  const halt = await expectHalt(runJob(w.deps(exec), plan.file));
  assert.equal(halt.error.code, "E_DEPLOYMENT_DRIFT");
  assert.equal(halt.error.retryability, "terminal");
  assert.deepEqual(exec.calls, []);
});

// ---------------------------------------------------------------------------
// The standalone `register` path shares the engine

test("register standalone: reuse-existing resolver, identity none, no records", async () => {
  const w = world();
  w.chain.resolvers.set(w.chain.predicted(OWNER).toLowerCase(), { owner: OWNER, verified: true });
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w, request({ identity: null, records: { addr: null, texts: {} }, resolverMode: "reuse-existing" }));
  assert.equal(plan.kind, "new");
  assert.equal(plan.file.intent.identity, "none");
  assert.deepEqual(stepsFor(plan.file.intent), ["canonicality_check", "commitment_submit", "payment_token_approve", "commitment_wait", "price_recheck", "registration_submit", "ens_verify"]);
  const file = await runJob(w.deps(exec), plan.file);
  assertCompleted(file, { identity: false });
  assert.equal(file.job.outcome.identity, "not_requested");
  assert.equal(file.job.result.verification.identity, undefined);
  assert.deepEqual(exec.calls, ["commitment_submit", "payment_token_approve", "registration_submit"]);
});

test("register standalone refuses when the resolver is not deployed", async () => {
  const w = world();
  await assert.rejects(startJob(w, request({ identity: null, records: { addr: null, texts: {} }, resolverMode: "reuse-existing" })), (e) => e.err?.code === "E_RESOLVER_NOT_PREPARED" || /E_RESOLVER_NOT_PREPARED|resolver/.test(String(e.message)));
});

test("a v0.3 pending-registrations checkpoint is adopted into the job so its commitment is kept", async () => {
  const w = world();
  w.chain.resolvers.set(w.chain.predicted(OWNER).toLowerCase(), { owner: OWNER, verified: true });
  // A legacy commit already on chain under a legacy secret.
  const legacy = { label: "durable", owner: OWNER, secret: `0x${"ab".repeat(32)}`, subregistry: "0x0000000000000000000000000000000000000000", resolver: w.chain.predicted(OWNER), durationSeconds: 31536000, referrer: `0x${"0".repeat(64)}` };
  legacy.commitment = w.chain.makeCommitment(legacy);
  w.chain.commitments.set(legacy.commitment, w.chain.time - 120);
  const plan = await startJob(w, request({ identity: null, records: { addr: null, texts: {} }, resolverMode: "reuse-existing" }));
  // startJob persisted the fresh file; adopt and re-persist as the register command does.
  assert.equal(adoptLegacyCommitment(plan.file, legacy), true);
  await w.store.put(plan.file);
  assert.equal(plan.file.job.facts.commitmentHash, legacy.commitment);
  const exec = mockExecutor(w.chain, OWNER);
  const file = await runJob(w.deps(exec), plan.file);
  assertCompleted(file, { identity: false });
  assert.equal(count(exec.calls, "commitment_submit"), 0, "the legacy commitment was reused");
  assert.equal(file.job.steps.find((s) => s.step === "commitment_submit").state, "skipped");
});

// ---------------------------------------------------------------------------
// Observation (dry-run)

test("observeJob reports what a resume would do without touching anything", async () => {
  const w = world();
  const first = mockExecutor(w.chain, OWNER, { killAfter: "registration_submit" });
  const plan = await startJob(w);
  const frozen = runJob(w.deps(first), plan.file);
  frozen.catch(() => {});
  await first.reached;
  const before = w.chain.applied.length;
  const obs = await observeJob(w.chain, SEPOLIA, await w.store.get(plan.file.job.jobId));
  assert.equal(w.chain.applied.length, before);
  const by = Object.fromEntries(obs.map((o) => [o.step, o]));
  assert.equal(by.resolver_deploy.wouldSubmit, false);
  assert.equal(by.commitment_submit.wouldSubmit, false);
  assert.equal(by.registration_submit.wouldSubmit, false);
  assert.equal(by.registration_submit.recorded, "in_progress");
  assert.equal(by.identity_bind.wouldSubmit, true);
  assert.equal(by.records_configure.wouldSubmit, true);
  const desired = desiredRecords(await w.store.get(plan.file.job.jobId), SEPOLIA);
  assert.equal(desired.addr, OWNER);
  assert.equal(Object.keys(desired.texts).length, 4, "the ENSIP-25 link is added only once the agent id is known");
});

test.after(() => {
  if (process.env.PRINT_MATRIX) {
    const rows = matrixRows.map((r) => `| \`${r.step}\` | ${r.killPoint} | ${r.observed} | ${r.action} | ${r.submissions} | ${r.result} |`);
    console.log(["| Step | Kill point | What resume observed on chain | Action taken | Submissions on resume | Result |", "|---|---|---|---|---:|---|", ...rows].join("\n"));
  }
});
