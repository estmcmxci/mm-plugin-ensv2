// The guards on buying the payment token with ETH (src/lib/swap.ts), ported
// from ensdomains/apps-monorepo#1684.
//
// These are the functions that decide whether the wallet is asked to send
// anything, so each one is tested against the case it exists to refuse — and
// every guard below was broken once, in dist, to confirm a test fails. The
// standard is #1684's own. What each break produced:
//
//   selectEthSwapQuote bounds amountIn instead of maximumEth
//     -> "rejects the cheapest pool when its SLIPPAGE LIMIT breaks the bound"
//   selectEthSwapQuote keeps pools that quoted nothing
//     -> "skips a pool that quoted nothing", "refuses when no pool quoted a route"
//   validateEthUsdRound ignores staleness
//     -> "refuses a stale round rather than bounding a swap with it"
//   validateEthUsdRound ignores answeredInRound
//     -> "refuses a round answered before it was asked"
//   validateEthUsdRound accepts a future round
//     -> "refuses a round from the future, which cannot be an answer"
//   ethSwapMaxFee loses its two-token floor
//     -> "the fee allowance is 3%, and never falls below two whole tokens" (+3 more)
//   feedScale hard-codes six decimals, as upstream does
//     -> "the feed scale follows the token's decimals instead of assuming six"
//   buildEthSwapCall drops refundETH
//     -> "the swap call refunds the ETH the pool did not take"
//   buildEthSwapCall caps the input at the output
//     -> "the swap call authorises exactly the quoted maximum"
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, parseAbi } from "viem";
import { MAINNET_ENSV2, SEPOLIA_ENSV2 } from "../dist/lib/deployments.js";
import {
  ETH_SWAP_REJECTED,
  ETH_SWAP_UNAVAILABLE,
  SWAP_CLOCK_MARGIN_SECONDS,
  SWAP_DEADLINE_SECONDS,
  buildEthSwapCall,
  ethNeededForSwap,
  ethSwapMaxFee,
  ethSwapRouter,
  ethSwapSupported,
  ethToTokenRaw,
  feedScale,
  isSwapRefusal,
  maxEthSwapInput,
  selectEthSwapQuote,
  swapDeadline,
  swapWrittenOffAt,
  validateEthUsdRound,
  withBps,
} from "../dist/lib/swap.js";

/** $2,266.00 with the feed's 8 decimals, roughly the price #1684 recorded. */
const ETH_USD = 226_600_000_000n;
const USDC_DECIMALS = 6;
/** 8.000021 USDC: a real mainnet quote for a free label. */
const AMOUNT_OUT = 8_000_021n;

const round = (over = {}) => ({ roundId: 100n, answer: ETH_USD, updatedAt: 1_000_000n, answeredInRound: 100n, ...over });

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return assert.fail("expected a refusal");
};

// ---------------------------------------------------------------------------
// The Chainlink round

test("accepts a fresh, well-formed round and returns its answer", () => {
  assert.equal(validateEthUsdRound(round(), 1_000_060n, 7_200n), ETH_USD);
});

test("refuses a stale round rather than bounding a swap with it", () => {
  assert.equal(codeOf(() => validateEthUsdRound(round(), 1_000_000n + 7_201n, 7_200n)), ETH_SWAP_UNAVAILABLE);
  // One second inside the window is still usable.
  assert.equal(validateEthUsdRound(round(), 1_000_000n + 7_200n, 7_200n), ETH_USD);
});

test("refuses a round answered before it was asked", () => {
  assert.equal(codeOf(() => validateEthUsdRound(round({ answeredInRound: 99n }), 1_000_060n, 7_200n)), ETH_SWAP_UNAVAILABLE);
});

test("refuses a round from the future, which cannot be an answer", () => {
  assert.equal(codeOf(() => validateEthUsdRound(round({ updatedAt: 1_000_100n }), 1_000_060n, 7_200n)), ETH_SWAP_UNAVAILABLE);
});

test("refuses a non-positive answer, however fresh", () => {
  for (const answer of [0n, -1n]) {
    assert.equal(codeOf(() => validateEthUsdRound(round({ answer }), 1_000_060n, 7_200n)), ETH_SWAP_UNAVAILABLE);
  }
  assert.equal(codeOf(() => validateEthUsdRound(round({ updatedAt: 0n }), 1_000_060n, 7_200n)), ETH_SWAP_UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// The price bound

test("the fee allowance is 3%, and never falls below two whole tokens", () => {
  // 3% of 8.000021 USDC is 0.24 USDC, which is under the floor.
  assert.equal(ethSwapMaxFee(AMOUNT_OUT, USDC_DECIMALS), 2_000_000n);
  // 3% of 1,000 USDC is 30 USDC, which is over it.
  assert.equal(ethSwapMaxFee(1_000_000_000n, USDC_DECIMALS), 30_000_000n);
});

test("the feed scale follows the token's decimals instead of assuming six", () => {
  // Upstream hard-codes 10^20 for USDC; this plugin prices in whatever the
  // oracle accepts, and an 18-decimal token is out by 10^12 if that is copied.
  assert.equal(feedScale(6), 10n ** 20n);
  assert.equal(feedScale(18), 10n ** 8n);
  // One ETH is worth the feed's price, whatever the token's scale.
  assert.equal(ethToTokenRaw(10n ** 18n, ETH_USD, 6), 2_266_000_000n);
  assert.equal(ethToTokenRaw(10n ** 18n, ETH_USD, 18), 2_266_000_000_000_000_000_000n);
});

test("the ETH bound covers the tokens plus the fee allowance, rounded up", () => {
  const bound = maxEthSwapInput(AMOUNT_OUT, ETH_USD, USDC_DECIMALS);
  // (8.000021 + 2) USDC at $2,266 is 0.004413… ETH. Derived here the long way
  // round rather than pasted, so the assertion is independent of the code.
  const tokens = AMOUNT_OUT + 2_000_000n;
  assert.equal(bound, (tokens * 10n ** 20n + ETH_USD - 1n) / ETH_USD);
  assert.equal(bound, 4_413_071_932_921_448n);
  assert.ok(bound > 4_400_000_000_000_000n && bound < 4_500_000_000_000_000n, "about 0.0044 ETH");
  // Never rounds down: a bound of zero would refuse every swap.
  assert.equal(maxEthSwapInput(1n, 10n ** 30n, USDC_DECIMALS), 1n);
});

test("withBps widens upwards, so a slippage cap is never short by a wei", () => {
  assert.equal(withBps(10_000n, 200n), 10_200n);
  assert.equal(withBps(1n, 200n), 2n, "rounded up, not truncated to 1");
});

// ---------------------------------------------------------------------------
// Choosing the pool

const quotes = [
  { fee: 500, amountIn: 4_000_000_000_000_000n },
  { fee: 3000, amountIn: 4_200_000_000_000_000n },
];

test("picks the cheapest pool that quoted, and reports its slippage limit", () => {
  const q = selectEthSwapQuote({ amountOut: AMOUNT_OUT, maxAmountIn: maxEthSwapInput(AMOUNT_OUT, ETH_USD, USDC_DECIMALS), ethUsd: ETH_USD, poolQuotes: quotes });
  assert.equal(q.fee, 500);
  assert.equal(q.amountIn, 4_000_000_000_000_000n);
  assert.equal(q.maximumEth, withBps(4_000_000_000_000_000n, 200n));
  assert.equal(q.ethUsd, ETH_USD, "the price the quote was held to travels with it");
});

test("skips a pool that quoted nothing instead of treating 0 as the cheapest route", () => {
  const q = selectEthSwapQuote({
    amountOut: AMOUNT_OUT,
    maxAmountIn: maxEthSwapInput(AMOUNT_OUT, ETH_USD, USDC_DECIMALS),
    ethUsd: ETH_USD,
    poolQuotes: [{ fee: 3000, amountIn: 0n }, ...quotes],
  });
  assert.equal(q.fee, 500);
});

test("refuses when no pool quoted a route at all", () => {
  assert.equal(
    codeOf(() => selectEthSwapQuote({ amountOut: AMOUNT_OUT, maxAmountIn: 10n ** 18n, ethUsd: ETH_USD, poolQuotes: [] })),
    ETH_SWAP_UNAVAILABLE,
  );
  assert.equal(
    codeOf(() => selectEthSwapQuote({ amountOut: AMOUNT_OUT, maxAmountIn: 10n ** 18n, ethUsd: ETH_USD, poolQuotes: [{ fee: 500, amountIn: 0n }] })),
    ETH_SWAP_UNAVAILABLE,
  );
});

test("rejects the cheapest pool when its SLIPPAGE LIMIT breaks the bound, not just its quote", () => {
  // amountIn is inside the bound; amountIn + 2% is not. The wallet authorises
  // the limit, so the limit is what has to be held.
  const bound = 4_000_000_000_000_000n;
  const q = [{ fee: 500, amountIn: 3_990_000_000_000_000n }];
  assert.ok(q[0].amountIn < bound, "the raw quote looks affordable");
  assert.ok(withBps(q[0].amountIn, 200n) > bound, "its slippage limit is not");
  assert.equal(codeOf(() => selectEthSwapQuote({ amountOut: AMOUNT_OUT, maxAmountIn: bound, ethUsd: ETH_USD, poolQuotes: q })), ETH_SWAP_REJECTED);
});

test("a rejected price and an unavailable market are both refusals, told apart by code", () => {
  const rejected = (() => {
    try {
      selectEthSwapQuote({ amountOut: AMOUNT_OUT, maxAmountIn: 1n, ethUsd: ETH_USD, poolQuotes: quotes });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(isSwapRefusal(rejected));
  assert.equal(rejected.code, ETH_SWAP_REJECTED);
  assert.ok(rejected.hint, "a refusal always says what to do instead");
  assert.equal(isSwapRefusal(new Error("something else")), false);
});

// ---------------------------------------------------------------------------
// The transaction

const routerAbi = parseAbi([
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function refundETH() payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);

const OWNER = "0x00000000000000000000000000000000000000A1";
const quote = { amountOut: AMOUNT_OUT, amountIn: 4_000_000_000_000_000n, maximumEth: 4_080_000_000_000_000n, fee: 500, ethUsd: ETH_USD };

test("the swap call refunds the ETH the pool did not take, in the same transaction", () => {
  const call = buildEthSwapCall({ quote, deployment: MAINNET_ENSV2, recipient: OWNER, deadline: 1_700_000_000n });
  const outer = decodeFunctionData({ abi: routerAbi, data: call.data });
  assert.equal(outer.functionName, "multicall");
  const [deadline, calls] = outer.args;
  assert.equal(deadline, 1_700_000_000n);
  assert.equal(calls.length, 2, "exactOutputSingle AND refundETH");
  assert.equal(decodeFunctionData({ abi: routerAbi, data: calls[1] }).functionName, "refundETH");
});

test("the swap call authorises exactly the quoted maximum, and buys an exact amount OUT", () => {
  const call = buildEthSwapCall({ quote, deployment: MAINNET_ENSV2, recipient: OWNER, deadline: 1_700_000_000n });
  const [, calls] = decodeFunctionData({ abi: routerAbi, data: call.data }).args;
  const p = decodeFunctionData({ abi: routerAbi, data: calls[0] }).args[0];
  assert.equal(p.amountOut, AMOUNT_OUT, "exact output is the whole reason this is not the host's own swap");
  assert.equal(p.amountInMaximum, quote.maximumEth);
  assert.equal(call.value, quote.maximumEth, "and the value sent matches what the router may take");
  assert.equal(p.recipient, OWNER, "the tokens land in the wallet, not at the router");
  assert.equal(p.tokenOut.toLowerCase(), MAINNET_ENSV2.paymentToken.toLowerCase(), "the deployment's payment token, not a hard-coded USDC");
});

test("the call targets the pinned router for the deployment's own chain", () => {
  const mainnet = buildEthSwapCall({ quote, deployment: MAINNET_ENSV2, recipient: OWNER, deadline: 1n });
  const sepolia = buildEthSwapCall({ quote, deployment: SEPOLIA_ENSV2, recipient: OWNER, deadline: 1n });
  assert.equal(mainnet.to, ethSwapRouter(1));
  assert.equal(sepolia.to, ethSwapRouter(11155111));
  assert.notEqual(mainnet.to, sepolia.to);
});

test("refuses to build for a chain with no pinned Uniswap and Chainlink pair", () => {
  assert.equal(ethSwapSupported(1), true);
  assert.equal(ethSwapSupported(11155111), true);
  assert.equal(ethSwapSupported(8453), false, "nothing is pinned on Base, so no swap is offered there");
  assert.equal(ethSwapRouter(8453), null);
  assert.equal(
    codeOf(() => buildEthSwapCall({ quote, deployment: { ...MAINNET_ENSV2, chainId: 8453 }, recipient: OWNER, deadline: 1n })),
    ETH_SWAP_UNAVAILABLE,
  );
});

test("refuses to send the tokens to the router itself", () => {
  assert.equal(
    codeOf(() => buildEthSwapCall({ quote, deployment: MAINNET_ENSV2, recipient: ethSwapRouter(1), deadline: 1n })),
    ETH_SWAP_UNAVAILABLE,
  );
});

// ---------------------------------------------------------------------------
// Gas and deadlines

test("the wallet must cover the swap plus TWICE its estimated gas", () => {
  assert.equal(ethNeededForSwap(quote, 1_000_000_000_000_000n), quote.maximumEth + 2_000_000_000_000_000n);
  assert.equal(ethNeededForSwap(quote, 0n), quote.maximumEth, "an unavailable estimate must not inflate the requirement");
});

test("a swap is written off only after its deadline plus a clock margin", () => {
  const deadline = swapDeadline(1_700_000_000);
  assert.equal(deadline, 1_700_000_000 + SWAP_DEADLINE_SECONDS);
  assert.equal(swapWrittenOffAt(deadline), deadline + SWAP_CLOCK_MARGIN_SECONDS);
  assert.ok(SWAP_CLOCK_MARGIN_SECONDS > 0, "our clock and the chain's disagree; buying again early pays twice");
});
