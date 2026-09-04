/**
 * Provisioning intent — the program's single authorization object
 * (provisioning-intent.schema.json 1.0.0), built for the direct-custody path.
 *
 * v0.6 constructs the intent and computes its EIP-712 digest exactly as the
 * frozen projection (eip712-provisioning-intent.json 1.0.0) defines it, but
 * does NOT sign it. Signing is v1.0's concern. The digest is still what
 * identifies the intent everywhere: it is `intentHash`, it is the
 * `idempotencyKey` verbatim, and the job id is derived from it.
 *
 * Determinism is the point. The same (chain, name, owner, duration, records,
 * identity config, spend ceiling) must always produce the same digest so a
 * second `provision` with the same inputs finds the same job. Two fields in
 * the signed projection exist only for signed, provider-facing intents and
 * would otherwise vary between runs: `nonce` (per-signer replay guard) and
 * `expiry` (absolute instant). For an unsigned, locally executed intent they
 * are fixed placeholders — nonce "0", expiry 2100-01-01 — and v1.0 replaces
 * them when it introduces signing. This is recorded as a design choice in the
 * v0.6 PR.
 *
 * Canonical JSON for the hashed sub-objects follows the projection's rule:
 * UTF-8, keys sorted by code point, no whitespace, no floating-point numbers,
 * integers as decimal strings.
 */
import { getAddress, hashTypedData, keccak256, stringToBytes, zeroHash, type Address, type Hex } from "viem";
import { labelhash } from "viem/ens";

export const DOMAIN_NAME = "MetaMask ENSv2 Provisioning";
export const DOMAIN_VERSION = "1";
export const ZERO32: Hex = zeroHash;
/** 2100-01-01T00:00:00Z. Placeholder for unsigned local intents; see header. */
export const INTENT_EXPIRY_PLACEHOLDER = 4102444800;
export const INTENT_NONCE_PLACEHOLDER = "0";

export type IntentRecord = { kind: "text" | "addr" | "contenthash"; key: string; value: string };

export type ResolverConfig = {
  mode: "deploy-owned" | "reuse-existing" | "explicit-address";
  address: Address;
  initializeForwardAddress: boolean;
  records: IntentRecord[];
};

export type IdentityConfig = {
  adapterProxy: Address;
  adapterImplementation: Address;
  erc8004Registry: Address;
  agentUri: string;
  publishEnsipRecords: boolean;
  controllerAddress: Address;
  bindingStandard: "erc721";
  anchorKind: "token-id";
};

export type ProvisioningIntent = {
  schemaVersion: "1.0.0";
  deploymentId: string;
  chain: `eip155:${number}`;
  name: { input: string; normalized: string; labelhash: Hex };
  owner: Address;
  durationSeconds: number;
  resolverConfigHash: Hex;
  resolverConfig: ResolverConfig;
  rolesConfigHash: Hex;
  payment: "direct";
  custodyMode: "direct";
  identity: "none" | "erc8004";
  identityConfigHash: Hex;
  identityConfig?: IdentityConfig;
  maxSpend: { asset: Address; maxTotalAmount: string; maxRegistrationAmount: string };
  nonce: string;
  expiry: number;
  idempotencyKey: Hex;
  eip712: { primaryType: "ProvisioningIntent"; domainName: typeof DOMAIN_NAME; domainVersion: typeof DOMAIN_VERSION; intentHash: Hex };
};

/** Canonical serialization for hashed sub-objects. Throws on numbers: the rule forbids floats and wants integers as strings. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") throw new Error("canonicalJson: numbers must be encoded as decimal strings");
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value ${String(value)}`);
}

/** keccak256 over the canonical JSON of a config object; bytes32(0) when absent. */
export function configHash(config: object | undefined | null): Hex {
  if (!config) return ZERO32;
  return keccak256(stringToBytes(canonicalJson(config)));
}

const ENUM = { payment: { direct: 0, x402: 1 }, custodyMode: { direct: 0, "sponsored-to-owner": 1, "provider-custody-transfer-last": 2 }, identity: { none: 0, erc8004: 1 } } as const;

const TYPES = {
  ProvisioningIntent: [
    { name: "nameLabelhash", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "durationSeconds", type: "uint64" },
    { name: "resolverConfigHash", type: "bytes32" },
    { name: "rolesConfigHash", type: "bytes32" },
    { name: "payment", type: "uint8" },
    { name: "custodyMode", type: "uint8" },
    { name: "identity", type: "uint8" },
    { name: "identityConfigHash", type: "bytes32" },
    { name: "maxSpendAsset", type: "address" },
    { name: "maxTotalAmount", type: "uint256" },
    { name: "providerId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/** The EIP-712 digest of an intent per eip712-provisioning-intent.json 1.0.0. Computed, never signed, in v0.6. */
export function intentDigest(i: Omit<ProvisioningIntent, "idempotencyKey" | "eip712">): Hex {
  const chainId = Number(i.chain.split(":")[1]);
  return hashTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, salt: keccak256(stringToBytes(i.deploymentId)) },
    types: TYPES,
    primaryType: "ProvisioningIntent",
    message: {
      nameLabelhash: i.name.labelhash,
      owner: i.owner,
      durationSeconds: BigInt(i.durationSeconds),
      resolverConfigHash: i.resolverConfigHash,
      rolesConfigHash: i.rolesConfigHash,
      payment: ENUM.payment[i.payment],
      custodyMode: ENUM.custodyMode[i.custodyMode],
      identity: ENUM.identity[i.identity],
      identityConfigHash: i.identityConfigHash,
      maxSpendAsset: i.maxSpend.asset,
      maxTotalAmount: BigInt(i.maxSpend.maxTotalAmount),
      providerId: ZERO32,
      nonce: BigInt(i.nonce),
      expiry: BigInt(i.expiry),
    },
  });
}

export type BuildIntentInput = {
  chainId: number;
  deploymentId: string;
  /** The user's raw input, kept for display only. */
  input: string;
  /** Registrable label under .eth, already normalized. */
  label: string;
  owner: Address;
  durationSeconds: number;
  resolver: Omit<ResolverConfig, "records">;
  records: IntentRecord[];
  identity: Omit<IdentityConfig, "bindingStandard" | "anchorKind" | "publishEnsipRecords"> | null;
  maxSpend: { asset: Address; maxTotalAmount: bigint };
};

/** Build a complete, schema-shaped intent with its hashes and digest. Pure. */
export function buildIntent(b: BuildIntentInput): ProvisioningIntent {
  const owner = getAddress(b.owner);
  const resolverConfig: ResolverConfig = { ...b.resolver, address: getAddress(b.resolver.address), records: b.records };
  const identityConfig: IdentityConfig | undefined = b.identity
    ? {
        adapterProxy: getAddress(b.identity.adapterProxy),
        adapterImplementation: getAddress(b.identity.adapterImplementation),
        erc8004Registry: getAddress(b.identity.erc8004Registry),
        agentUri: b.identity.agentUri,
        publishEnsipRecords: true,
        controllerAddress: getAddress(b.identity.controllerAddress),
        bindingStandard: "erc721",
        anchorKind: "token-id",
      }
    : undefined;
  const base: Omit<ProvisioningIntent, "idempotencyKey" | "eip712"> = {
    schemaVersion: "1.0.0",
    deploymentId: b.deploymentId,
    chain: `eip155:${b.chainId}`,
    name: { input: b.input, normalized: `${b.label}.eth`, labelhash: labelhash(b.label) },
    owner,
    durationSeconds: b.durationSeconds,
    resolverConfigHash: configHash(resolverConfig),
    resolverConfig,
    rolesConfigHash: ZERO32,
    payment: "direct",
    custodyMode: "direct",
    identity: identityConfig ? "erc8004" : "none",
    identityConfigHash: configHash(identityConfig),
    ...(identityConfig ? { identityConfig } : {}),
    maxSpend: { asset: getAddress(b.maxSpend.asset), maxTotalAmount: b.maxSpend.maxTotalAmount.toString(), maxRegistrationAmount: b.maxSpend.maxTotalAmount.toString() },
    nonce: INTENT_NONCE_PLACEHOLDER,
    expiry: INTENT_EXPIRY_PLACEHOLDER,
  };
  const digest = intentDigest(base);
  return { ...base, idempotencyKey: digest, eip712: { primaryType: "ProvisioningIntent", domainName: DOMAIN_NAME, domainVersion: DOMAIN_VERSION, intentHash: digest } };
}

/** Recompute the hashes an intent claims and confirm they match. A stored intent is never trusted on its own word. */
export function intentIsConsistent(i: ProvisioningIntent): boolean {
  if (configHash(i.resolverConfig) !== i.resolverConfigHash) return false;
  if (configHash(i.identityConfig) !== i.identityConfigHash) return false;
  if (i.rolesConfigHash !== ZERO32) return false;
  const digest = intentDigest(i);
  return digest === i.eip712.intentHash && digest === i.idempotencyKey;
}

/**
 * Job id: deterministic in (chainId, normalized name, owner, intent hash), so
 * a second `provision` with the same inputs lands on the same job. 128 bits of
 * keccak256 over a canonical string, lowercase hex, no prefix.
 */
export function jobIdFor(chainId: number, normalizedName: string, owner: Address, intentHash: Hex): string {
  const h = keccak256(stringToBytes(`mm-plugin-ensv2/job@1|${chainId}|${normalizedName}|${owner.toLowerCase()}|${intentHash.toLowerCase()}`));
  return h.slice(2, 34);
}
