// The ETH-funded path through the job engine: `payment_settle` buys the
// payment token the wallet is short, and never buys it twice.
//
// Run against the in-memory chain (test/mock-chain.mjs), whose router decodes
// the real `multicall(deadline, [exactOutputSingle, refundETH])` calldata,
// enforces the deadline, takes only what the pool needed and refunds the
// rest — so what these tests exercise is the calldata the wallet would
// actually be handed.
//
// The invariants under test, each broken once in dist to confirm a test fails:
//
//   the step skips unless --pay-with eth was passed
//   the shortfall is re-derived from the balance, never read from the record
//   a swap still inside its deadline stops the run instead of buying again
//   past its deadline (plus the clock margin) a fresh swap is sent
//   a refused quote halts before the wallet is asked for anything
import assert from "node:assert/strict";
import { test } from "node:test";
import { SEPOLIA } from "../dist/lib/deployments.js";
import { MemoryJobStore, validateJobFile } from "../dist/lib/jobs.js";
import { memorySwapCheckpoints } from "../dist/lib/pendingswap.js";
import { ProvisionHalt, planProvision, runJob, stepsFor } from "../dist/lib/provision.js";
import { ReadError } from "../dist/lib/reads.js";
import { SCHEMA_IDS, validateSchema } from "../dist/lib/schema.js";
import { ETH_SWAP_REJECTED, SWAP_CLOCK_MARGIN_SECONDS, SWAP_DEADLINE_SECONDS } from "../dist/lib/swap.js";
import { MockChain, mockExecutor } from "./mock-chain.mjs";

const OWNER = "0x00000000000000000000000000000000000000A1";
const ONE_ETH = 10n ** 18n;

const request = (over = {}) => ({
  input: "Ethpaid",
  owner: OWNER,
  durationSeconds: 31536000n,
  identity: null,
  records: { texts: {} },
  resolverMode: "deploy-owned",
  ...over,
});

/**
 * A world whose wallet holds ETH but NOT the payment token — the case the
 * whole ETH path exists for, and the one an agent wallet is actually in.
 */
function world({ tokenBalance = 0n, ethBalance = ONE_ETH } = {}) {
  const logs = [];
  const chain = new MockChain();
  chain.fund(OWNER, tokenBalance);
  chain.fundEth(OWNER, ethBalance);
  // A resolver already deployed and attested keeps these runs to the funding steps.
  chain.resolvers.set(chain.predicted(OWNER).toLowerCase(), { owner: OWNER, verified: true });
  const store = new MemoryJobStore();
  const checkpoints = memorySwapCheckpoints();
  const deps = (exec) => ({
    chain,
    verifyChain: chain,
    deployment: SEPOLIA,
    submit: exec.submit,
    store,
    swapCheckpoints: checkpoints,
    now: () => new Date(chain.time * 1000),
    sleep: async (ms) => {
      chain.time += Math.max(1, Math.ceil(ms / 1000));
      chain.block += 1n;
    },
    log: (level, msg) => logs.push(msg),
    progress: () => {},
  });
  return { chain, store, checkpoints, deps, logs };
}

async function startJob(w, req = request(), opts = {}) {
  const plan = await planProvision({ chain: w.chain, deployment: SEPOLIA, store: w.store }, req, { checkFunding: false, ...opts });
  if (plan.kind === "new") await w.store.create(plan.file);
  return plan;
}

async function expectHalt(p) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProvisionHalt) return e;
    throw e;
  }
  return assert.fail("expected the job to halt");
}

const stepOf = (file, name) => file.job.steps.find((s) => s.step === name);

// ---------------------------------------------------------------------------

test("payment_settle is a step of every job, so a record never has to grow one", () => {
  const steps = stepsFor({ resolverConfig: { mode: "deploy-owned", records: [] }, identity: "none" });
  assert.ok(steps.includes("payment_settle"));
  assert.equal(steps.indexOf("payment_settle"), steps.indexOf("payment_token_approve") - 1, "it settles the funding before the approval, inside the commitment wait");
});

test("without --pay-with eth the step skips and the run halts on funds, as it always did", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  const halt = await expectHalt(runJob(w.deps(exec), plan.file));

  assert.equal(halt.error.code, "E_INSUFFICIENT_FUNDS");
  assert.equal(stepOf(halt.file, "payment_settle").state, "skipped");
  assert.ok(
    w.logs.some((l) => /payment_settle: short 8000021 USDC units; paying with ETH was not requested/.test(l)),
    "and it says so, rather than skipping silently",
  );
  assert.deepEqual(w.chain.swaps, [], "no swap by omission, ever");
  assert.match(halt.error.recoveryAction.description, /mm ensv2 faucet/, "chain 11155111 keeps the faucet");
});

test("with --pay-with eth the wallet buys exactly the shortfall and the job completes", async () => {
  const w = world({ tokenBalance: 3_000_000n });
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  const file = await runJob(w.deps(exec), plan.file, { payWith: "eth" });

  assert.equal(file.job.state, "completed");
  assert.equal(stepOf(file, "payment_settle").state, "succeeded");
  assert.equal(w.chain.swaps.length, 1);
  // 8.000021 quoted, 3.000000 held: exactly 5.000021 bought, not the whole quote.
  assert.equal(w.chain.swaps[0].amountOut, 5_000_021n);
  assert.equal(w.chain.balances.get(OWNER.toLowerCase()), 0n, "and the registration then spent it all");
  validateJobFile(file);
  assert.ok(validateSchema(SCHEMA_IDS.job, file.job).ok, "a job record with the new step is still schema-valid");
});

test("the swap leaves no step receipt, because step-receipt 1.0.0 cannot carry one", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  const file = await runJob(w.deps(exec), plan.file, { payWith: "eth" });

  const step = stepOf(file, "payment_settle");
  assert.equal(step.state, "succeeded");
  assert.equal(step.receipts, undefined, "step-receipt 1.0.0's stepName enum does not list payment_settle");
  // So the swap is absent from the job's transaction tally, and — because the
  // frozen step item is additionalProperties:false, with no field for a note —
  // from the record entirely. It is reported in the run's log and nowhere
  // durable. This is the open question in the PRD, asserted here so that the
  // answer cannot change without a test changing with it.
  const swapHash = w.chain.applied.find((a) => a.fn.startsWith("multicall")).hash;
  assert.ok(!JSON.stringify(file.job).includes(swapHash), "nowhere in the job record");
  assert.ok(
    w.logs.some((l) => l.includes(swapHash)),
    "the run's log is the only place it is reported",
  );
});

test("the ETH actually spent is only what the pool took, and the rest comes back", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  await runJob(w.deps(exec), plan.file, { payWith: "eth" });

  const swap = w.chain.swaps[0];
  const spent = ONE_ETH - w.chain.ethBalances.get(OWNER.toLowerCase());
  assert.equal(spent, swap.amountIn, "refundETH returned the slippage allowance that was not needed");
  assert.ok(spent < 4_500_000_000_000_000n, "about 0.0035 ETH for 8 USDC at $2,266");
});

test("a swap already sent and still inside its deadline stops the run instead of buying twice", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  // A previous run's swap: recorded, not yet reflected in the balance.
  w.checkpoints.put({
    chainId: SEPOLIA.chainId,
    owner: OWNER,
    deploymentId: SEPOLIA.deploymentId,
    amountOut: "8000021",
    maximumEth: "4000000000000000",
    fee: 500,
    deadline: w.chain.time + SWAP_DEADLINE_SECONDS,
    txHash: "0xfeed000000000000000000000000000000000000000000000000000000000001",
    createdAt: new Date(w.chain.time * 1000).toISOString(),
  });

  const halt = await expectHalt(runJob(w.deps(exec), plan.file, { payWith: "eth" }));

  assert.equal(halt.error.code, "E_PAYMENT_SETTLEMENT_UNKNOWN");
  assert.equal(halt.error.retryability, "indeterminate");
  assert.equal(halt.error.recoveryAction.kind, "inspect_settlement_before_any_retry");
  assert.match(halt.error.recoveryAction.description, /Do not send another swap/);
  assert.deepEqual(w.chain.swaps, [], "nothing was bought");
  assert.ok(validateSchema(SCHEMA_IDS.errors, halt.error).ok, "and the halt is a schema-valid program error");
});

test("past its deadline plus the clock margin, the saved swap is written off and a fresh one is sent", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  const deadline = w.chain.time - SWAP_CLOCK_MARGIN_SECONDS - 1;
  w.checkpoints.put({
    chainId: SEPOLIA.chainId,
    owner: OWNER,
    deploymentId: SEPOLIA.deploymentId,
    amountOut: "8000021",
    maximumEth: "4000000000000000",
    fee: 500,
    deadline,
    txHash: "0xfeed000000000000000000000000000000000000000000000000000000000002",
    createdAt: new Date((deadline - SWAP_DEADLINE_SECONDS) * 1000).toISOString(),
  });

  const file = await runJob(w.deps(exec), plan.file, { payWith: "eth" });

  assert.equal(file.job.state, "completed");
  assert.equal(w.chain.swaps.length, 1, "the router refuses the old call now, so buying again is safe");
  assert.equal(w.checkpoints.get(SEPOLIA.chainId, OWNER), null, "and the record is cleared");
});

test("a swap that landed after a cancelled run is COUNTED, not bought again", async () => {
  // The tokens are in the wallet and a record still says a swap went out:
  // exactly the state a cancelled run leaves behind.
  const w = world({ tokenBalance: 8_000_021n });
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  w.checkpoints.put({
    chainId: SEPOLIA.chainId,
    owner: OWNER,
    deploymentId: SEPOLIA.deploymentId,
    amountOut: "8000021",
    maximumEth: "4000000000000000",
    fee: 500,
    deadline: w.chain.time + SWAP_DEADLINE_SECONDS,
    txHash: "0xfeed000000000000000000000000000000000000000000000000000000000003",
    createdAt: new Date(w.chain.time * 1000).toISOString(),
  });

  const file = await runJob(w.deps(exec), plan.file, { payWith: "eth" });

  assert.equal(file.job.state, "completed");
  assert.deepEqual(w.chain.swaps, [], "the balance already covered the quote, so nothing was bought");
  assert.equal(w.checkpoints.get(SEPOLIA.chainId, OWNER), null, "the record has done its job and goes");
  assert.ok(w.logs.some((l) => /covering the 8000021 quoted/.test(l)), "and it says the balance was counted, not ignored");
});

test("the shortfall is re-derived from the balance, so a partial swap buys only the remainder", async () => {
  const w = world({ tokenBalance: 8_000_020n });
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  const file = await runJob(w.deps(exec), plan.file, { payWith: "eth" });

  assert.equal(file.job.state, "completed");
  assert.equal(w.chain.swaps[0].amountOut, 1n, "one unit short, one unit bought");
});

test("a quote outside the Chainlink bound halts before the wallet is asked for anything", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  w.chain.swapQuoteError = new ReadError(ETH_SWAP_REJECTED, "The pools price ETH too far above the oracle.", "Try again later.");

  const halt = await expectHalt(runJob(w.deps(exec), plan.file, { payWith: "eth" }));

  assert.equal(halt.error.code, "E_PAYMENT_REJECTED");
  assert.equal(halt.error.retryability, "requires_user_action");
  assert.deepEqual(exec.calls.filter((c) => c === "payment_settle"), [], "the wallet never saw a request");
  assert.equal(w.checkpoints.get(SEPOLIA.chainId, OWNER), null, "and nothing was recorded as in flight");
  assert.ok(validateSchema(SCHEMA_IDS.errors, halt.error).ok);
});

test("a wallet without the ETH to cover the swap and twice its gas halts, having sent nothing", async () => {
  const w = world({ ethBalance: 3_000_000_000_000_000n });
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);

  const halt = await expectHalt(runJob(w.deps(exec), plan.file, { payWith: "eth" }));

  assert.equal(halt.error.code, "E_INSUFFICIENT_FUNDS");
  assert.match(halt.error.message, /Nothing was sent/);
  assert.deepEqual(w.chain.swaps, []);
  assert.equal(w.checkpoints.get(SEPOLIA.chainId, OWNER), null);
});

test("a denied swap clears the record, because nothing can land", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER, { deny: "payment_settle" });
  const plan = await startJob(w);

  const halt = await expectHalt(runJob(w.deps(exec), plan.file, { payWith: "eth" }));

  assert.equal(halt.error.code, "E_POLICY_DENIED");
  assert.equal(halt.error.retryability, "requires_user_action");
  assert.equal(w.checkpoints.get(SEPOLIA.chainId, OWNER), null, "refused before signing: there is nothing in flight to protect");
  assert.deepEqual(w.chain.swaps, []);
});

test("a swap whose outcome the wallet never confirms KEEPS the record, so the next run cannot buy twice", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER, { trackingExpiredLost: "payment_settle" });
  const plan = await startJob(w);

  const halt = await expectHalt(runJob(w.deps(exec), plan.file, { payWith: "eth" }));

  assert.equal(halt.error.code, "E_PAYMENT_SETTLEMENT_UNKNOWN");
  assert.equal(halt.error.retryability, "indeterminate");
  const saved = w.checkpoints.get(SEPOLIA.chainId, OWNER);
  assert.ok(saved, "the swap may still land, and the record is what says so");
  assert.equal(saved.txHash, null, "no hash was returned; the deadline is what eventually clears it");

  // And a second run refuses rather than buying again.
  const second = await expectHalt(runJob(w.deps(mockExecutor(w.chain, OWNER)), halt.file, { payWith: "eth" }));
  assert.equal(second.error.code, "E_PAYMENT_SETTLEMENT_UNKNOWN");
  assert.deepEqual(w.chain.swaps, []);
});

test("a swap that reverts clears the record and is retried from a fresh quote", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  // The router refuses a call past its deadline; make the chain's clock jump
  // between building and mining, which is the real revert this guard is for.
  const realApply = w.chain.apply.bind(w.chain);
  w.chain.apply = (from, calldata) => {
    if (calldata.to.toLowerCase() !== SEPOLIA.paymentToken.toLowerCase() && calldata.data.startsWith("0x5ae401dc")) {
      w.chain.time += SWAP_DEADLINE_SECONDS + 60;
    }
    return realApply(from, calldata);
  };

  const halt = await expectHalt(runJob(w.deps(exec), plan.file, { payWith: "eth" }));

  assert.equal(halt.error.code, "E_TRANSACTION_REVERTED");
  assert.equal(halt.error.evidence.revertConfirmed, true);
  assert.equal(w.checkpoints.get(SEPOLIA.chainId, OWNER), null, "it cannot land now, so nothing is in flight");
  assert.deepEqual(w.chain.swaps, [], "and no tokens were bought");
});

test("the step refuses to spend ETH on a registration the job could not then pay for", async () => {
  const w = world();
  const exec = mockExecutor(w.chain, OWNER);
  const plan = await startJob(w);
  // The price moved above the ceiling the job was created with.
  w.chain.price = 20_000_000n;

  const halt = await expectHalt(runJob(w.deps(exec), plan.file, { payWith: "eth" }));

  assert.equal(halt.error.code, "E_PRICE_EXCEEDS_MAX_SPEND");
  assert.match(halt.error.message, /Nothing was bought/);
  assert.deepEqual(w.chain.swaps, []);
});
