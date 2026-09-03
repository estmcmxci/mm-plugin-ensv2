/**
 * Name helpers. DNS wire-format encoding is what every Universal Resolver
 * and registry-navigation call takes; namehash/labelhash are what the
 * registry and resolver storage are keyed by.
 */
import { bytesToHex, type Hex } from "viem";
import { normalize } from "viem/ens";

export function normalizeName(raw: string): string {
  const name = normalize(raw.trim());
  if (!name || !name.includes(".")) {
    throw new Error(`"${raw}" is not a fully qualified ENS name (e.g. name.eth)`);
  }
  return name;
}

/** DNS wire format: length-prefixed labels, null terminator. "a.eth" -> 0x01 61 03 65 74 68 00 */
export function dnsEncode(name: string): Hex {
  const out: number[] = [];
  for (const label of name.split(".")) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length === 0 || bytes.length > 255) throw new Error(`invalid DNS label "${label}"`);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return bytesToHex(new Uint8Array(out));
}

/** Decode DNS wire format starting at `offset` (bytes). Used to name the ancestor a resolver was inherited from. */
export function dnsDecode(bytes: Uint8Array, offset = 0): string {
  const labels: string[] = [];
  let i = offset;
  while (i < bytes.length) {
    const len = bytes[i]!;
    i += 1;
    if (len === 0) break;
    labels.push(new TextDecoder().decode(bytes.slice(i, i + len)));
    i += len;
  }
  return labels.join(".");
}

/** First label. The registry entry for `sub.name.eth` is keyed by labelhash("sub") in the registry that holds it. */
export function leafLabel(name: string): string {
  return name.split(".")[0]!;
}
