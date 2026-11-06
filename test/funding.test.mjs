// The insufficient-funds hint must be followable ON THE CHAIN IT IS GIVEN ON.
//
// Every funding refusal used to say "On Sepolia, run `mm ensv2 faucet`", on
// mainnet too, where the faucet cannot work: the open `mint` belongs to the
// test deployments' MockUSDC, and real USDC has none. So the one suggestion
// the plugin made to a mainnet caller was impossible, and it made no other.
//
// Probed against the installed host (agent-wallet 7.3.0) while writing this:
//   mm swap quote --from ETH --to USDC --amount 0.01 --from-chain-id 11155111
//     -> UNSUPPORTED_CHAIN, "Swaps are not supported on Ethereum Sepolia (testnet)."
//   mm swap quote --from ETH --to USDC --amount 0.01 --from-chain-id 1
//     -> priced, then INSUFFICIENT_FUNDS on the wallet's own balance
// which is why Sepolia keeps the faucet and only chain 1 names the swap.
import assert from "node:assert/strict";
import { test } from "node:test";
// `SEPOLIA` is the legacy export name of the dead `beta` table; the canonical
// Sepolia deployment is `SEPOLIA_ENSV2` (see deployments.ts).
import { MAINNET_ENSV2, SEPOLIA as SEPOLIA_BETA, SEPOLIA_ENSV2, SEPOLIA_HACKATHON } from "../dist/lib/deployments.js";
import { fundingHint } from "../dist/lib/registrar.js";

const USDC = { symbol: "USDC", decimals: 6 };
/** 8.000021 USDC — a real mainnet quote for a free label, from the README. */
const SHORTFALL = 8_000_021n;

test("Sepolia is told to use the faucet, and is never sent to a swap that refuses testnets", () => {
  const hint = fundingHint(SEPOLIA_ENSV2, SHORTFALL, USDC);
  assert.match(hint, /mm ensv2 faucet --deployment sepolia/, "the hint's own command must not itself be refused");
  assert.doesNotMatch(hint, /mm swap/, "the host refuses swaps on Sepolia with UNSUPPORTED_CHAIN");
  assert.match(hint, /8\.000021 or more test USDC/, "it names what the wallet is actually short");
});

test("the other Sepolia tables answer like Sepolia — they are the same chain and the same mock token", () => {
  for (const d of [SEPOLIA_HACKATHON, SEPOLIA_BETA]) {
    const hint = fundingHint(d, SHORTFALL, USDC);
    assert.match(hint, new RegExp(`mm ensv2 faucet --deployment ${d.key}`), `${d.key} is on chain ${d.chainId}`);
    assert.doesNotMatch(hint, /mm swap/);
  }
});

test("mainnet names the host's swap, the exact-in caveat, and 3% of headroom", () => {
  const hint = fundingHint(MAINNET_ENSV2, SHORTFALL, USDC);
  assert.match(hint, /mm swap quote --from ETH --to USDC --amount <eth> --from-chain-id 1\b/);
  assert.match(hint, /mm swap execute --quote-id/);
  assert.match(hint, /exact-IN/, "the caller must know --amount is the ETH going in, not the USDC coming out");
  assert.match(hint, /8\.000021/, "the shortfall itself");
  assert.match(hint, /8\.240022/, "and 3% above it, rounded up, as the figure to quote against");
});

test("mainnet says why the faucet is not the answer, instead of staying silent about it", () => {
  const hint = fundingHint(MAINNET_ENSV2, SHORTFALL, USDC);
  assert.match(hint, /`mm ensv2 faucet` cannot help here/);
  assert.match(hint, /real USDC/);
});

test("the headroom is rounded up, so it never lands under the shortfall", () => {
  // 1 unit + 3% = 1.03 units; truncation would quote 1 and leave the wallet short.
  assert.match(fundingHint(MAINNET_ENSV2, 1n, { symbol: "USDC", decimals: 0 }), /covers 2\b/);
});

test("an unpinned chain gets a fundable instruction rather than a command that cannot work", () => {
  const elsewhere = { ...MAINNET_ENSV2, chainId: 8453 };
  const hint = fundingHint(elsewhere, SHORTFALL, USDC);
  assert.doesNotMatch(hint, /mm ensv2 faucet/);
  assert.doesNotMatch(hint, /mm swap/);
  assert.match(hint, /chain 8453/);
  assert.match(hint, new RegExp(elsewhere.paymentToken), "name the token, since nothing else here does");
});

test("the hint is phrased for whatever the registrar prices in, not for USDC by name", () => {
  const dai = { symbol: "DAI", decimals: 18 };
  const hint = fundingHint(MAINNET_ENSV2, 8_000_000_000_000_000_000n, dai);
  assert.match(hint, /--to DAI /, "the swap must target what the registrar prices in");
  assert.match(hint, /Buy the 8 DAI/);
  assert.match(hint, /covers 8\.24\b/);
});
