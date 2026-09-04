/**
 * ERC-7930 interoperable addresses, as used by ENSIP-25 for the registry
 * parameter. Binary layout (v1, EVM):
 *
 *   0001            version
 *   0000            chain type: eip155
 *   <len:1>         chain reference length
 *   <chainId>       minimal big-endian bytes
 *   14              address length (20)
 *   <address:20>
 *
 * Reproduces the ENSIP-25 example for mainnet's registry byte-for-byte:
 *   0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";

export function encodeErc7930(chainId: number, address: Address): Hex {
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`invalid chain id ${chainId}`);
  let ref = chainId.toString(16);
  if (ref.length % 2) ref = "0" + ref;
  const refLen = (ref.length / 2).toString(16).padStart(2, "0");
  return `0x00010000${refLen}${ref}14${address.slice(2).toLowerCase()}`;
}

export function decodeErc7930(hex: string): { chainId: number; address: Address } | null {
  const h = hex.toLowerCase().replace(/^0x/, "");
  if (!h.startsWith("00010000")) return null;
  const refLen = parseInt(h.slice(8, 10), 16);
  const ref = h.slice(10, 10 + refLen * 2);
  const rest = h.slice(10 + refLen * 2);
  if (!rest.startsWith("14") || rest.length !== 2 + 40) return null;
  const addr = `0x${rest.slice(2)}`;
  if (!isAddress(addr)) return null;
  return { chainId: parseInt(ref, 16), address: getAddress(addr) };
}

/** ENSIP-25 key. agentId MUST NOT contain '[' or ']'. */
export function ensip25Key(chainId: number, registry: Address, agentId: string): string {
  if (/[[\]]/.test(agentId)) throw new Error("agentId must not contain '[' or ']'");
  return `agent-registration[${encodeErc7930(chainId, registry)}][${agentId}]`;
}

export type Ensip25Ref = { key: string; chainId: number; registry: Address; agentId: string };

export function parseEnsip25Key(key: string): Ensip25Ref | null {
  const m = /^agent-registration\[(0x[0-9a-fA-F]+)\]\[([^[\]]+)\]$/.exec(key);
  if (!m) return null;
  const dec = decodeErc7930(m[1]!);
  if (!dec) return null;
  return { key, chainId: dec.chainId, registry: dec.address, agentId: m[2]! };
}
