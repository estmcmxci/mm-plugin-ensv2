/**
 * The chain surface the provisioning engine (provision.ts) reads through.
 *
 * Everything the engine needs to re-derive completion state lives behind this
 * interface, so the engine can run against the host's viem client in the
 * plugin and against an in-memory chain in the interruption tests. The viem
 * implementation composes the existing library functions — nothing here
 * re-implements a read that reads.ts / resolver.ts / registrar.ts / agent.ts
 * / records.ts already provide.
 */
import { getAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { identityRegistryAbi } from "./abis.js";
import { agentInfo, findAgentIdsForName, type AgentInfo } from "./agent.js";
import type { EnsV2Deployment } from "./deployments.js";
import { detectEnsV2, type EnsV2Detection } from "./ensv2.js";
import { ensClient, resolverInfo, whois, type ResolverInfo, type WhoisInfo } from "./reads.js";
import { readAddr, readText, type RecordRead } from "./records.js";
import {
  chainTime,
  checkAvailable,
  commitmentTime,
  computeCommitment,
  quoteRegistration,
  tokenState,
  type Availability,
  type CommitmentParams,
  type Quote,
} from "./registrar.js";
import { ownedResolverStatus, type OwnedResolverStatus } from "./resolver.js";

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export type ReceiptLite = {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  from: Address;
  to: Address | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: { address: Address; data: Hex; topics: readonly Hex[] }[];
};

export type CurrentRecords = { addr: RecordRead; texts: Record<string, RecordRead> };

export interface ProvisionChain {
  /** The fail-closed gate. */
  detect(): Promise<EnsV2Detection>;
  chainTime(): Promise<number>;
  blockNumber(): Promise<bigint>;
  resolverStatus(owner: Address): Promise<OwnedResolverStatus>;
  available(label: string): Promise<Availability>;
  quote(label: string, durationSeconds: bigint): Promise<Quote>;
  tokenState(owner: Address): Promise<{ balance: bigint; allowance: bigint }>;
  computeCommitment(p: CommitmentParams): Promise<Hex>;
  commitmentTime(commitment: Hex): Promise<number>;
  whois(name: string): Promise<WhoisInfo>;
  resolverInfo(name: string): Promise<ResolverInfo>;
  /** Forward resolution THROUGH the Universal Resolver. */
  forwardAddress(name: string): Promise<RecordRead>;
  currentRecords(name: string, textKeys: string[]): Promise<CurrentRecords>;
  adapterImplementation(): Promise<Address>;
  agentInfo(name: string, agentId: bigint): Promise<AgentInfo>;
  findAgentIds(name: string): Promise<{ agentIds: bigint[]; registeredBy: Record<string, Address>; scannedFrom: bigint; scannedTo: bigint }>;
  /** ERC-8004 reserved metadata key `agent-binding`, decoded to an address when it is 20 bytes. */
  bindingMetadata(agentId: bigint): Promise<Address | null>;
  /** null while the transaction is not (yet) mined. */
  receipt(hash: Hex): Promise<ReceiptLite | null>;
}

export function viemProvisionChain(client: PublicClient, d: EnsV2Deployment): ProvisionChain {
  return {
    detect: () => detectEnsV2(client, d),
    chainTime: () => chainTime(client),
    blockNumber: () => client.getBlockNumber(),
    resolverStatus: (owner) => ownedResolverStatus(client, d, owner),
    available: (label) => checkAvailable(client, d, label),
    quote: (label, duration) => quoteRegistration(client, d, label, duration),
    tokenState: (owner) => tokenState(client, d, owner),
    computeCommitment: (p) => computeCommitment(client, d, p),
    commitmentTime: (c) => commitmentTime(client, d, c),
    whois: (name) => whois(client, d, name),
    resolverInfo: (name) => resolverInfo(client, d, name),
    forwardAddress: (name) => readAddr(ensClient(client, d.chainId), d, name),
    currentRecords: async (name, textKeys) => {
      const ens = ensClient(client, d.chainId);
      const [addr, ...texts] = await Promise.all([readAddr(ens, d, name), ...textKeys.map((k) => readText(ens, d, name, k))]);
      const out: CurrentRecords = { addr, texts: {} };
      textKeys.forEach((k, i) => (out.texts[k] = texts[i]!));
      return out;
    },
    adapterImplementation: async () => {
      const raw = await client.getStorageAt({ address: d.adapter8004, slot: EIP1967_IMPLEMENTATION_SLOT });
      if (!raw || raw === "0x" || BigInt(raw) === 0n) return zeroAddress;
      return getAddress(`0x${raw.slice(-40)}`);
    },
    agentInfo: (name, id) => agentInfo(client, d, name, id),
    findAgentIds: async (name) => {
      const s = await findAgentIdsForName(client, d, name, { all: true });
      return { agentIds: s.agentIds, registeredBy: s.registeredBy, scannedFrom: s.scannedFrom, scannedTo: s.scannedTo };
    },
    bindingMetadata: async (agentId) => {
      const raw = await client.readContract({ address: d.identityRegistry, abi: identityRegistryAbi, functionName: "getMetadata", args: [agentId, "agent-binding"] });
      if (!raw || raw === "0x") return null;
      const hex = raw.slice(2);
      if (hex.length !== 40 && hex.length !== 64) return null;
      const addr = getAddress(`0x${hex.slice(-40)}`);
      return isAddressEqual(addr, zeroAddress) ? null : addr;
    },
    receipt: async (hash) => {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return {
          status: r.status === "success" ? "success" : "reverted",
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
          from: r.from,
          to: r.to ?? null,
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
          logs: r.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })),
        };
      } catch (error) {
        if (error instanceof Error && /not (be )?found|could not find/i.test(error.message)) return null;
        throw error;
      }
    },
  };
}
