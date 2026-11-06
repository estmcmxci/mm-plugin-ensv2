/**
 * Buying the payment token with ETH, so a wallet that holds only ETH can pay
 * for a registration.
 *
 * Ported from ENS Labs' `eth-usdc-swap.ts` (ensdomains/apps-monorepo#1684,
 * merged 2026-11-03), which added the same funding path to the registration
 * checkout in `apps/manager`. The guards, the pool set, the slippage and the
 * Chainlink bound are theirs; what changed here is the plumbing:
 *
 *  - `neverthrow` Results become thrown `ReadError`s, the idiom the rest of
 *    this library uses, so a command maps one to a CommandError and the job
 *    engine halts with a frozen E_PAYMENT_* code.
 *  - the token is the DEPLOYMENT's payment token, read from our pinned table,
 *    not `getDestinationContracts(chainId).usdc`.
 *  - the USDC-shaped constants are parameterised by the token's decimals.
 *    Upstream hard-codes 6 (the floor fee is `2_000_000n`, the feed scale
 *    `10n ** 20n`); both are only correct for a 6-decimal token, and this
 *    plugin prices in whatever `isPaymentToken` accepts.
 *
 * EXACT OUTPUT is the whole point, and the reason this is a port rather than a
 * call to the host's own `mm swap`. A registration costs an exact number of
 * token units, and `multicall(deadline, [exactOutputSingle, refundETH])` buys
 * exactly that: the router wraps the ETH, takes only what the pool needs and
 * refunds the rest in the same transaction. The host's SwapService (and every
 * DEX aggregator) is exact-IN — you name the ETH going in and the output is an
 * estimate — so it can land under the quote, which reverts `register`, or over
 * it, which leaves dust. #1684 rejected the Rhinestone aggregators for the
 * same reason, and also found no aggregator serves a same-chain testnet swap;
 * the host confirms it, refusing chain 11155111 with UNSUPPORTED_CHAIN.
 *
 * Every quote is held to the Chainlink ETH/USD feed before the wallet is
 * asked to send anything. A pool that cannot fill is skipped, not trusted.
 */
import { encodeFunctionData, isAddressEqual, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { MAINNET_CHAIN_ID, SEPOLIA_CHAIN_ID, type EnsV2Deployment } from "./deployments.js";
import { ReadError } from "./reads.js";
import type { Calldata } from "./registrar.js";

/** Uniswap v3 QuoterV2, SwapRouter02 and the WETH they route, by chain id. */
const UNISWAP_V3: Readonly<Record<number, { readonly quoter: Address; readonly router: Address; readonly weth: Address }>> = {
  [MAINNET_CHAIN_ID]: {
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  [SEPOLIA_CHAIN_ID]: {
    quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  },
};

/** Chainlink ETH/USD aggregators, 8 decimals, by chain id. */
const ETH_USD_FEEDS: Readonly<Record<number, { readonly address: Address; readonly maxAgeSeconds: bigint }>> = {
  // Heartbeat one hour; two allows for a late round.
  [MAINNET_CHAIN_ID]: { address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", maxAgeSeconds: 7_200n },
  // The testnet feed updates far less often.
  [SEPOLIA_CHAIN_ID]: { address: "0x694AA1769357215DE4FAC081bf1f309aDC325306", maxAgeSeconds: 86_400n },
};

const quoterAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const routerAbi = parseAbi([
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function refundETH() payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
const ethUsdFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export const POOL_FEES = [500, 3000, 10000] as const;
export type PoolFee = (typeof POOL_FEES)[number];

const BPS = 10_000n;
/** What the swap may cost over its quote before it reverts. */
export const SWAP_SLIPPAGE_BPS = 200n;
/** The Chainlink feed's own scale. */
const FEED_DECIMALS = 8n;

/** How long a swap stays valid once sent; past it the router refuses the call. */
export const SWAP_DEADLINE_SECONDS = 1_200;
/**
 * Added to a saved swap's deadline before it is written off. Our clock and the
 * chain's disagree, and buying again while the first swap can still land is
 * the one mistake this whole file exists to avoid.
 */
export const SWAP_CLOCK_MARGIN_SECONDS = 300;

/** No swap can be offered: no feed, no trustworthy price, or no pool that fills. */
export const ETH_SWAP_UNAVAILABLE = "ENSV2_ETH_SWAP_UNAVAILABLE";
/** The pools price ETH too far from the Chainlink feed to swap now. */
export const ETH_SWAP_REJECTED = "ENSV2_ETH_SWAP_REJECTED";

const unavailable = (message: string, hint: string) => new ReadError(ETH_SWAP_UNAVAILABLE, message, hint);
const rejected = (message: string, hint: string) => new ReadError(ETH_SWAP_REJECTED, message, hint);

const divCeil = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/** `value` widened by `bps`, rounded up. */
export const withBps = (value: bigint, bps: bigint): bigint => divCeil(value * (BPS + bps), BPS);

/** 10^(18 - tokenDecimals + 8): ETH's 18 decimals against the token's and the feed's. */
export function feedScale(decimals: number): bigint {
  return 10n ** (18n - BigInt(decimals) + FEED_DECIMALS);
}

/**
 * The most a swap may cost over the token it delivers, at the Chainlink
 * price: 3%, and never less than 2 whole tokens. Covers the pool fee and the
 * slippage allowance.
 */
export function ethSwapMaxFee(amountOut: bigint, decimals: number): bigint {
  const threePercent = (amountOut * 3n) / 100n;
  const floor = 2n * 10n ** BigInt(decimals);
  return threePercent > floor ? threePercent : floor;
}

/** The most ETH (wei) buying `amountOut` token units may take, fee included. */
export function maxEthSwapInput(amountOut: bigint, ethUsd: bigint, decimals: number): bigint {
  return divCeil((amountOut + ethSwapMaxFee(amountOut, decimals)) * feedScale(decimals), ethUsd);
}

/** What `wei` is worth in token units at `ethUsd` (8 decimals), rounded down. */
export const ethToTokenRaw = (wei: bigint, ethUsd: bigint, decimals: number): bigint => (wei * ethUsd) / feedScale(decimals);

export type EthUsdRound = Readonly<{ roundId: bigint; answer: bigint; updatedAt: bigint; answeredInRound: bigint }>;

/**
 * The round's ETH/USD price (8 decimals), or a refusal. A stale round, a
 * non-positive answer, a round answered before it was asked, or a timestamp
 * in the future all mean the feed cannot be trusted to bound a swap.
 */
export function validateEthUsdRound(round: EthUsdRound, nowSeconds: bigint, maxAgeSeconds: bigint): bigint {
  const usable =
    round.answer > 0n &&
    round.answeredInRound >= round.roundId &&
    round.updatedAt > 0n &&
    round.updatedAt <= nowSeconds &&
    nowSeconds - round.updatedAt <= maxAgeSeconds;
  if (!usable) {
    throw unavailable(
      `The Chainlink ETH/USD round is not usable (answer ${round.answer}, updated ${round.updatedAt}, now ${nowSeconds}, max age ${maxAgeSeconds}s).`,
      "The price feed is stale or unavailable, and no swap is priced without it. Try again later, or fund the wallet with the payment token directly.",
    );
  }
  return round.answer;
}

/** The Chainlink ETH/USD price (8 decimals) for this chain, refused when stale or unusable. */
export async function readEthUsdPrice(client: PublicClient, chainId: number, nowSeconds: bigint): Promise<bigint> {
  const feed = ETH_USD_FEEDS[chainId];
  if (!feed) throw unavailable(`No Chainlink ETH/USD feed is pinned for chain ${chainId}.`, "Paying with ETH is not available on this network.");
  let round: readonly [bigint, bigint, bigint, bigint, bigint];
  try {
    round = await client.readContract({ address: feed.address, abi: ethUsdFeedAbi, functionName: "latestRoundData" });
  } catch (error) {
    throw unavailable(
      `The Chainlink ETH/USD feed at ${feed.address} could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      "The price feed is unavailable, and no swap is priced without it. Try again later.",
    );
  }
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  return validateEthUsdRound({ roundId, answer, updatedAt, answeredInRound }, nowSeconds, feed.maxAgeSeconds);
}

/** A swap of ETH for exactly `amountOut` token units through one Uniswap v3 pool. */
export type EthSwapQuote = Readonly<{
  /** Raw payment-token units the swap delivers. Exact. */
  amountOut: bigint;
  /** What the pool quoted, in wei. */
  amountIn: bigint;
  /** What the wallet sends: the quote plus slippage. Unused ETH is refunded. */
  maximumEth: bigint;
  fee: PoolFee;
  /** The Chainlink price the quote was held to, 8 decimals. */
  ethUsd: bigint;
}>;

/**
 * The cheapest pool's quote, if it stays within the Chainlink bound EVEN AT
 * its slippage limit. A pool with no route quotes nothing and is skipped.
 *
 * Bounding `maximumEth` rather than `amountIn` is deliberate: `maximumEth` is
 * what the wallet actually authorises the router to take, so that is the
 * figure the price check has to hold.
 */
export function selectEthSwapQuote(params: {
  readonly amountOut: bigint;
  readonly maxAmountIn: bigint;
  readonly ethUsd: bigint;
  readonly poolQuotes: readonly { fee: PoolFee; amountIn: bigint }[];
}): EthSwapQuote {
  const { amountOut, maxAmountIn, ethUsd, poolQuotes } = params;
  const cheapest = poolQuotes
    .filter(({ amountIn }) => amountIn > 0n)
    .reduce<{ fee: PoolFee; amountIn: bigint } | undefined>((best, q) => (!best || q.amountIn < best.amountIn ? q : best), undefined);
  if (!cheapest) {
    throw unavailable(
      "No Uniswap v3 pool quoted a route from ETH to the payment token.",
      "No ETH-to-token swap is available right now. Fund the wallet with the payment token directly.",
    );
  }
  const maximumEth = withBps(cheapest.amountIn, SWAP_SLIPPAGE_BPS);
  if (maximumEth > maxAmountIn) {
    throw rejected(
      `The cheapest pool (${cheapest.fee / 10_000}%) wants up to ${maximumEth} wei for ${amountOut} token units; the Chainlink bound is ${maxAmountIn} wei.`,
      "The pools price ETH too far above the oracle to buy safely. Try again later, or fund the wallet with the payment token directly.",
    );
  }
  return { amountOut, amountIn: cheapest.amountIn, maximumEth, fee: cheapest.fee, ethUsd };
}

/**
 * Quote buying exactly `amountOut` of the deployment's payment token with
 * ETH, held to the Chainlink price. Reads only; sends nothing.
 */
export async function quoteEthSwap(
  client: PublicClient,
  d: EnsV2Deployment,
  params: { amountOut: bigint; decimals: number; nowSeconds: bigint },
): Promise<EthSwapQuote> {
  const uniswap = UNISWAP_V3[d.chainId];
  if (!uniswap) throw unavailable(`No Uniswap v3 deployment is pinned for chain ${d.chainId}.`, "Paying with ETH is not available on this network.");
  const ethUsd = await readEthUsdPrice(client, d.chainId, params.nowSeconds);

  // A pool that does not exist or cannot fill reverts; that pool is skipped.
  const settled = await Promise.allSettled(
    POOL_FEES.map(async (fee) => {
      // The quoter is not `view`: it reverts with the result, so simulate it.
      const { result } = await client.simulateContract({
        address: uniswap.quoter,
        abi: quoterAbi,
        functionName: "quoteExactOutputSingle",
        args: [{ tokenIn: uniswap.weth, tokenOut: d.paymentToken, amount: params.amountOut, fee, sqrtPriceLimitX96: 0n }],
      });
      return { fee, amountIn: result[0] };
    }),
  );
  return selectEthSwapQuote({
    amountOut: params.amountOut,
    maxAmountIn: maxEthSwapInput(params.amountOut, ethUsd, params.decimals),
    ethUsd,
    poolQuotes: settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
  });
}

/**
 * The swap transaction: buy exactly the quoted token amount for `recipient`,
 * then refund the ETH the pool did not take, atomically, before `deadline`.
 */
export function buildEthSwapCall(params: { quote: EthSwapQuote; deployment: EnsV2Deployment; recipient: Address; deadline: bigint }): Calldata {
  const { quote, deployment: d, recipient, deadline } = params;
  const uniswap = UNISWAP_V3[d.chainId];
  if (!uniswap) throw unavailable(`No Uniswap v3 deployment is pinned for chain ${d.chainId}.`, "Paying with ETH is not available on this network.");
  if (isAddressEqual(recipient, uniswap.router)) {
    throw unavailable("The swap recipient cannot be the router itself.", "Paying with ETH is not available for this wallet.");
  }
  const swap = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactOutputSingle",
    args: [
      {
        tokenIn: uniswap.weth,
        tokenOut: d.paymentToken,
        fee: quote.fee,
        recipient,
        amountOut: quote.amountOut,
        amountInMaximum: quote.maximumEth,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const refund = encodeFunctionData({ abi: routerAbi, functionName: "refundETH" });
  return {
    to: uniswap.router,
    data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [deadline, [swap, refund]] }),
    value: quote.maximumEth,
  };
}

/** Whether this chain can price an ETH swap at all, without reading anything. */
export function ethSwapSupported(chainId: number): boolean {
  return !!UNISWAP_V3[chainId] && !!ETH_USD_FEEDS[chainId];
}

/** The router this chain's swap goes through, for an intent summary. */
export function ethSwapRouter(chainId: number): Address | null {
  return UNISWAP_V3[chainId]?.router ?? null;
}

/**
 * What the wallet must hold in ETH to send this swap: the swap itself plus
 * TWICE the estimated gas, so a gas-price move between estimate and send does
 * not strand the registration half-funded.
 */
export function ethNeededForSwap(quote: EthSwapQuote, gasCostWei: bigint): bigint {
  return quote.maximumEth + 2n * gasCostWei;
}

export type { Calldata };

/**
 * Everything the standalone `ensv2 register` needs to send a swap, quoted and
 * guarded, having sent nothing. The job engine runs the same guards in the
 * same order against its own ProvisionChain, because it has to turn each
 * refusal into a different frozen E_PAYMENT_* code; both get the guards
 * themselves from the pure functions above, which is where they live.
 */
export async function planEthSwap(
  client: PublicClient,
  d: EnsV2Deployment,
  params: { shortfall: bigint; decimals: number; owner: Address; ceiling: bigint; nowSeconds: number },
): Promise<{ quote: EthSwapQuote; call: Calldata; deadline: number; neededEth: bigint; ethBalance: bigint }> {
  const quote = await quoteEthSwap(client, d, { amountOut: params.shortfall, decimals: params.decimals, nowSeconds: BigInt(params.nowSeconds) });
  // The ETH ceiling is derived from the token ceiling the caller already
  // accepted, at the oracle price plus the same max fee.
  const ethCeiling = maxEthSwapInput(params.ceiling, quote.ethUsd, params.decimals);
  if (quote.maximumEth > ethCeiling) {
    throw rejected(
      `The swap would authorise up to ${quote.maximumEth} wei; ${params.ceiling} token units are worth ${ethCeiling} wei at the oracle price.`,
      "The pools price ETH too far above the oracle to buy safely. Try again later, or fund the wallet with the payment token directly.",
    );
  }
  const deadline = swapDeadline(params.nowSeconds);
  const call = buildEthSwapCall({ quote, deployment: d, recipient: params.owner, deadline: BigInt(deadline) });
  const [gasCost, ethBalance] = await Promise.all([
    client
      .estimateGas({ account: params.owner, to: call.to, data: call.data, value: call.value })
      .then(async (gas) => gas * (await client.getGasPrice()))
      .catch(() => 0n),
    client.getBalance({ address: params.owner }),
  ]);
  const neededEth = ethNeededForSwap(quote, gasCost);
  if (ethBalance < neededEth) {
    throw unavailable(
      `Buying ${params.shortfall} token units needs up to ${quote.maximumEth} wei plus gas (${neededEth} wei in all); this wallet holds ${ethBalance} wei.`,
      `Send this wallet at least ${neededEth - ethBalance} more wei of ETH, or fund it with the payment token directly and drop --pay-with eth.`,
    );
  }
  return { quote, call, deadline, neededEth, ethBalance };
}

/**
 * True when `error` is one of this module's refusals, decided BY SHAPE rather
 * than by class — the same rule `revertName` follows in registrar.ts, and for
 * a related reason: an error can cross a module or package boundary and lose
 * its prototype, and a swap refusal misread as a bug becomes E_INTERNAL
 * ("report this") instead of E_PAYMENT_REJECTED ("the price moved, here is
 * what to do"). The code is the contract.
 */
export function isSwapRefusal(error: unknown): error is ReadError {
  if (error == null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === ETH_SWAP_UNAVAILABLE || code === ETH_SWAP_REJECTED;
}

/** The deadline a swap sent now should carry, in unix seconds of CHAIN time. */
export function swapDeadline(chainNowSeconds: number): number {
  return chainNowSeconds + SWAP_DEADLINE_SECONDS;
}

/** Past this instant a saved swap can no longer land, so buying again is safe. */
export function swapWrittenOffAt(deadline: number): number {
  return deadline + SWAP_CLOCK_MARGIN_SECONDS;
}

export type { Hex };
