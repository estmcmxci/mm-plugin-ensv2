/**
 * ETHRegistrar reads for v0.3 — availability and pricing. Pure; no SDK import.
 *
 * Facts these encode, from the deployed contracts and ENS docs:
 *  - isAvailable() is false for every pre-migrated ENSv1 name (they sit as
 *    RESERVED in v2) and for names in their grace period. Only the registrar
 *    can answer this; do not infer it from getState().
 *  - Price is denominated in an ERC-20 the oracle whitelists (MockUSDC on the
 *    Sepolia beta), not ETH, and is paid by msg.sender at register() time.
 *  - Use the REGISTRAR's getRegisterPrice, not the oracle's: it derives how
 *    long the name has been available (premium decay) and reverts for
 *    unavailable names or too-short durations. The oracle's overload is for
 *    hypotheticals.
 *  - MIN_REGISTER_DURATION is 28 days on Sepolia and appears in no doc; it is
 *    read from chain here rather than assumed.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  formatUnits,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { erc20Abi, ethRegistrarAbi, rentPriceOracleAbi } from "./abis.js";
import type { EnsV2Deployment } from "./deployments.js";
import { ethLabel } from "./names.js";
import { ReadError } from "./reads.js";

export const SECONDS_PER_YEAR = 365n * 86400n;

/** Surface a decoded custom error by name; leave anything else to the caller. */
export function revertName(error: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const r = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r?.data?.errorName) return null;
  return { name: r.data.errorName, args: r.data.args ?? [] };
}

export type Availability = {
  label: string;
  name: string;
  available: boolean;
  /** Seconds. Read from chain. */
  minRegisterDuration: number;
  minCommitmentAge: number;
  maxCommitmentAge: number;
};

export async function checkAvailable(client: PublicClient, d: EnsV2Deployment, input: string): Promise<Availability> {
  const label = ethLabel(input);
  const reg = { address: d.registrar, abi: ethRegistrarAbi } as const;
  const [available, minDur, minAge, maxAge] = await Promise.all([
    client.readContract({ ...reg, functionName: "isAvailable", args: [label] }),
    client.readContract({ ...reg, functionName: "MIN_REGISTER_DURATION" }),
    client.readContract({ ...reg, functionName: "MIN_COMMITMENT_AGE" }),
    client.readContract({ ...reg, functionName: "MAX_COMMITMENT_AGE" }),
  ]);
  return {
    label,
    name: `${label}.eth`,
    available,
    minRegisterDuration: Number(minDur),
    minCommitmentAge: Number(minAge),
    maxCommitmentAge: Number(maxAge),
  };
}

export type Quote = {
  label: string;
  name: string;
  durationSeconds: number;
  durationYears: number;
  paymentToken: { address: Address; symbol: string; decimals: number };
  /** Raw token units, as decimal strings (bigint-safe for --json). */
  base: string;
  premium: string;
  total: string;
  /** Human units, e.g. "5.00". */
  formatted: { base: string; premium: string; total: string };
  minRegisterDuration: number;
};

export async function quoteRegistration(client: PublicClient, d: EnsV2Deployment, input: string, durationSeconds: bigint): Promise<Quote> {
  const label = ethLabel(input);
  const tok = { address: d.paymentToken, abi: erc20Abi } as const;

  const [accepted, symbol, decimals, minDur] = await Promise.all([
    client.readContract({ address: d.rentPriceOracle, abi: rentPriceOracleAbi, functionName: "isPaymentToken", args: [d.paymentToken] }),
    client.readContract({ ...tok, functionName: "symbol" }),
    client.readContract({ ...tok, functionName: "decimals" }),
    client.readContract({ address: d.registrar, abi: ethRegistrarAbi, functionName: "MIN_REGISTER_DURATION" }),
  ]);
  if (!accepted) {
    throw new ReadError("ENSV2_PAYMENT_TOKEN_UNSUPPORTED", `The oracle does not accept ${d.paymentToken} (${symbol}) as a payment token.`, "The deployment table's paymentToken is stale. Check the ENS deployments page.");
  }
  if (durationSeconds < minDur) {
    throw new ReadError(
      "ENSV2_DURATION_TOO_SHORT",
      `Duration ${durationSeconds}s is below the registrar minimum of ${minDur}s (${Number(minDur) / 86400} days).`,
      "Pass a longer --years (0.08 ≈ 28 days).",
    );
  }

  let base: bigint;
  let premium: bigint;
  try {
    [base, premium] = await client.readContract({
      address: d.registrar,
      abi: ethRegistrarAbi,
      functionName: "getRegisterPrice",
      args: [label, durationSeconds, d.paymentToken],
    });
  } catch (error) {
    const r = revertName(error);
    if (r?.name === "NameNotAvailable") {
      throw new ReadError("ENSV2_NAME_NOT_AVAILABLE", `${label}.eth is not available to register.`, "Registered, in grace, or reserved from ENSv1 pre-migration. Check `ensv2 whois`.");
    }
    if (r?.name === "DurationTooShort") {
      throw new ReadError("ENSV2_DURATION_TOO_SHORT", `Duration below the registrar minimum (${String(r.args[1])}s).`, "Pass a longer --years.");
    }
    throw error;
  }

  const total = base + premium;
  const fmt = (v: bigint) => formatUnits(v, decimals);
  return {
    label,
    name: `${label}.eth`,
    durationSeconds: Number(durationSeconds),
    durationYears: Number(durationSeconds) / Number(SECONDS_PER_YEAR),
    paymentToken: { address: d.paymentToken, symbol, decimals },
    base: base.toString(),
    premium: premium.toString(),
    total: total.toString(),
    formatted: { base: fmt(base), premium: fmt(premium), total: fmt(total) },
    minRegisterDuration: Number(minDur),
  };
}

// ---------------------------------------------------------------------------
// Write-side builders. Pure: they return unsigned calldata for the executor.

export type Calldata = { to: Address; data: Hex; value: bigint };

/** 32 random bytes; the commitment secret. Generated once per registration and checkpointed before commit. */
export function makeSecret(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export type CommitmentParams = {
  label: string;
  owner: Address;
  secret: Hex;
  subregistry: Address;
  resolver: Address;
  durationSeconds: bigint;
  referrer: Hex;
};

/** Ask the registrar for the commitment hash rather than hashing locally — the on-chain function is the reference. */
export async function computeCommitment(client: PublicClient, d: EnsV2Deployment, p: CommitmentParams): Promise<Hex> {
  return client.readContract({
    address: d.registrar,
    abi: ethRegistrarAbi,
    functionName: "makeCommitment",
    args: [p.label, p.owner, p.secret, p.subregistry, p.resolver, p.durationSeconds, p.referrer],
  });
}

export function buildApprove(d: EnsV2Deployment, amount: bigint): Calldata {
  return { to: d.paymentToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.registrar, amount] }), value: 0n };
}

export function buildCommit(d: EnsV2Deployment, commitment: Hex): Calldata {
  return { to: d.registrar, data: encodeFunctionData({ abi: ethRegistrarAbi, functionName: "commit", args: [commitment] }), value: 0n };
}

export function buildRegister(d: EnsV2Deployment, p: CommitmentParams): Calldata {
  return {
    to: d.registrar,
    data: encodeFunctionData({
      abi: ethRegistrarAbi,
      functionName: "register",
      args: [p.label, p.owner, p.secret, p.subregistry, p.resolver, p.durationSeconds, d.paymentToken, p.referrer],
    }),
    value: 0n,
  };
}

/** MockUSDC's open mint. Sepolia beta only; there is no equivalent on a real token. */
export function buildMint(d: EnsV2Deployment, to: Address, amount: bigint): Calldata {
  return { to: d.paymentToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [to, amount] }), value: 0n };
}

export async function tokenState(client: PublicClient, d: EnsV2Deployment, owner: Address): Promise<{ balance: bigint; allowance: bigint }> {
  const tok = { address: d.paymentToken, abi: erc20Abi } as const;
  const [balance, allowance] = await Promise.all([
    client.readContract({ ...tok, functionName: "balanceOf", args: [owner] }),
    client.readContract({ ...tok, functionName: "allowance", args: [owner, d.registrar] }),
  ]);
  return { balance, allowance };
}

export async function commitmentTime(client: PublicClient, d: EnsV2Deployment, commitment: Hex): Promise<number> {
  return Number(await client.readContract({ address: d.registrar, abi: ethRegistrarAbi, functionName: "commitmentAt", args: [commitment] }));
}

export async function chainTime(client: PublicClient): Promise<number> {
  const b = await client.getBlock({ blockTag: "latest" });
  return Number(b.timestamp);
}

export const ZERO_ADDRESS = zeroAddress;
export const ZERO_REFERRER = zeroHash;

/** Parse `--years` (decimal allowed) into whole seconds. */
export function yearsToSeconds(raw: string | undefined, fallbackYears = 1): bigint {
  const years = raw == null || raw === "" ? fallbackYears : Number(raw);
  if (!Number.isFinite(years) || years <= 0) throw new ReadError("ENSV2_INVALID_DURATION", `'${raw}' is not a positive number of years.`, "Example: --years 1 or --years 0.5");
  return BigInt(Math.round(years * Number(SECONDS_PER_YEAR)));
}
