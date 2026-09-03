/**
 * Local checkpoint for in-flight registrations.
 *
 * ENSv2 registration is commit → wait ≥ 60 s → register, and the register
 * call must reproduce the exact (label, owner, secret, subregistry, resolver,
 * duration, referrer) tuple that was committed. If the process dies between
 * the two transactions and the secret is lost, the commitment is unusable and
 * the user pays for a second commit and waits again. So the tuple is written
 * to disk BEFORE the commit transaction is sent, and cleared after a verified
 * registration.
 *
 * File: ~/.mm-plugin-ensv2/pending-registrations.json, mode 0600. The secret
 * is not a key and cannot move funds, but it is the only thing that lets a
 * commitment be completed, so it is treated as private and never logged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";

export type PendingRegistration = {
  chainId: number;
  label: string;
  owner: Address;
  secret: Hex;
  subregistry: Address;
  resolver: Address;
  durationSeconds: number;
  referrer: Hex;
  commitment: Hex;
  commitTx: Hex | null;
  /** Chain timestamp of the commit, once known. */
  commitTime: number | null;
  createdAt: string;
};

const DIR = join(homedir(), ".mm-plugin-ensv2");
const FILE = join(DIR, "pending-registrations.json");

type Store = Record<string, PendingRegistration>;

const key = (chainId: number, label: string) => `${chainId}:${label}`;

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

export function getPending(chainId: number, label: string): PendingRegistration | null {
  return load()[key(chainId, label)] ?? null;
}

export function putPending(p: PendingRegistration): void {
  const s = load();
  s[key(p.chainId, p.label)] = p;
  save(s);
}

export function clearPending(chainId: number, label: string): void {
  const s = load();
  delete s[key(chainId, label)];
  save(s);
}

export const pendingFilePath = FILE;
