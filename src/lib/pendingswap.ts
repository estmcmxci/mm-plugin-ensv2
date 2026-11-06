/**
 * Local checkpoint for an ETH-to-payment-token swap that has been sent.
 *
 * The swap is the one step of an ETH-funded registration that spends money
 * without leaving a step receipt: `payment_settle` is in the job schema's step
 * enum but not in step-receipt's, so there is nowhere frozen to file the
 * transaction (see the PRD's open question). This file plays the receipt's
 * part. It is written BEFORE the swap is sent, so a process that dies between
 * the request and the confirmation still knows a swap may be in flight — and
 * a second run therefore refuses to buy again instead of paying twice.
 *
 * Keyed by (chain, wallet) rather than by name or job, deliberately. The
 * tokens land in the wallet, not in a registration: a run that is cancelled
 * after its swap confirms has still bought them, and the next run for ANY
 * name on that chain should count them. #1684 keeps its `pendingEthSwap`
 * outside the run record for the same reason.
 *
 * How much to buy is NEVER read from this file. It is always re-derived from
 * the wallet's on-chain balance against the quote, so a partially-filled,
 * replaced or duplicated swap cannot make the engine buy the wrong amount.
 * The record only answers "might a swap still land?", and the deadline it
 * carries is what eventually answers "no".
 *
 * File: ~/.mm-plugin-ensv2/pending-swaps.json, mode 0600.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";

export type PendingSwap = {
  chainId: number;
  owner: Address;
  /** The deployment this swap was sent for; two tables share chain 11155111. */
  deploymentId: string;
  /** Raw payment-token units the swap was sent to buy. Evidence, not an instruction. */
  amountOut: string;
  /** Wei the router was allowed to take. */
  maximumEth: string;
  /** Uniswap v3 pool fee, in hundredths of a bip. */
  fee: number;
  /** Unix seconds of CHAIN time; past this the router refuses the multicall. */
  deadline: number;
  /** Null between writing the checkpoint and learning the hash. */
  txHash: Hex | null;
  createdAt: string;
};

const DIR = join(homedir(), ".mm-plugin-ensv2");
const FILE = join(DIR, "pending-swaps.json");

type Store = Record<string, PendingSwap>;

const key = (chainId: number, owner: Address) => `${chainId}:${owner.toLowerCase()}`;

function load(): Store {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export function getPendingSwap(chainId: number, owner: Address): PendingSwap | null {
  return load()[key(chainId, owner)] ?? null;
}

export function putPendingSwap(p: PendingSwap): void {
  const s = load();
  s[key(p.chainId, p.owner)] = p;
  save(s);
}

export function clearPendingSwap(chainId: number, owner: Address): void {
  const s = load();
  delete s[key(chainId, owner)];
  save(s);
}

export const pendingSwapFilePath = FILE;

/**
 * The checkpoint store as an injectable surface, so the job engine can be run
 * against an in-memory one in the tests exactly as it is run against the
 * in-memory chain and job store.
 */
export type SwapCheckpoints = {
  get(chainId: number, owner: Address): PendingSwap | null;
  put(p: PendingSwap): void;
  clear(chainId: number, owner: Address): void;
};

export const fileSwapCheckpoints: SwapCheckpoints = {
  get: getPendingSwap,
  put: putPendingSwap,
  clear: clearPendingSwap,
};

export function memorySwapCheckpoints(): SwapCheckpoints {
  const store = new Map<string, PendingSwap>();
  return {
    get: (chainId, owner) => store.get(key(chainId, owner)) ?? null,
    put: (p) => void store.set(key(p.chainId, p.owner), p),
    clear: (chainId, owner) => void store.delete(key(chainId, owner)),
  };
}
