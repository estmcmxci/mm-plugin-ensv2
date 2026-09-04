/**
 * Host wiring for the job engine: the pieces of provision/jobs/register that
 * touch the Agent Wallet SDK. Like gate.ts this is one of the two lib modules
 * allowed to import the plugin SDK; provision.ts itself never does, so it
 * stays runnable against a plain viem client (scripts/check.mjs) and the
 * in-memory chain (test/).
 */
import { CommandError, type CommandIO, type PluginCommandContext } from "@metamask/agent-wallet/plugin";
import { createPublicClient, formatUnits, http, type Address, type PublicClient } from "viem";
import { erc20Abi } from "./abis.js";
import { viemProvisionChain, type ProvisionChain } from "./chain.js";
import type { EnsV2Deployment } from "./deployments.js";
import { toCommandError } from "./gate.js";
import { FileJobStore, JobExistsError, type JobFile, type JobStore, type ProgramError } from "./jobs.js";
import { walletResultToSubmitResult, type WalletResultLike } from "./executor.js";
import { PlanRefused, ProvisionHalt, type EngineDeps, type Submit } from "./provision.js";

/** Independent second endpoint for the final verification. Flag, then env, then the public Sepolia RPC. */
export function verifyRpcUrl(flag?: string): string {
  return flag || process.env.MM_ENSV2_VERIFY_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
}

export function verifyChainFor(d: EnsV2Deployment, url: string): ProvisionChain {
  return viemProvisionChain(createPublicClient({ transport: http(url) }), d);
}

/** Wrap ctx.walletExecutor as the engine's Submit. The plugin never sees a key; MetaMask policy signs. */
export async function submitVia(ctx: PluginCommandContext, io: CommandIO, commandId: string, chainId: number): Promise<Submit> {
  const execute = await ctx.walletExecutor(io, commandId);
  return async (req) => {
    const r = await execute(
      {
        kind: "transaction",
        chainId,
        transaction: { to: req.calldata.to, data: req.calldata.data, value: req.calldata.value },
        intent: { summary: req.summary, action: "call", details: req.details },
      },
      { waitForReceipt: true, signal: io.signal },
    );
    // pendingJob is a fox-sdk PendingJobEntry: its handle is `pollingId` (the id `mm wallet requests watch` takes).
    return walletResultToSubmitResult(r as WalletResultLike);
  };
}

export async function engineDeps(opts: {
  ctx: PluginCommandContext;
  io: CommandIO;
  commandId: string;
  client: PublicClient;
  deployment: EnsV2Deployment;
  store: JobStore;
  verifyRpc?: string;
}): Promise<EngineDeps> {
  const { ctx, io, commandId, client, deployment: d, store } = opts;
  return {
    chain: viemProvisionChain(client, d),
    verifyChain: verifyChainFor(d, verifyRpcUrl(opts.verifyRpc)),
    deployment: d,
    submit: await submitVia(ctx, io, commandId, d.chainId),
    store,
    log: (level, msg) => io.log(level, msg),
    progress: (msg) => io.progress(msg),
    signal: io.signal,
  };
}

export const defaultStore = () => new FileJobStore();

/** A program error as the host reports it: the program code IS the command error code; the recovery action is the hint. */
export function programErrorToCommandError(e: ProgramError, store?: JobStore): CommandError {
  const jobId = e.evidence?.jobId;
  const where = jobId && store?.location(jobId) ? ` Job file: ${store.location(jobId)}.` : "";
  const inspect = jobId ? ` Inspect with \`mm ensv2 jobs show ${jobId}\`.` : "";
  return new CommandError(e.code, `${e.message} [${e.retryability}]`, `${e.recoveryAction.description}${inspect}${where}`);
}

/** Map anything the engine or plan throws onto a host CommandError. */
export function jobErrorToCommandError(error: unknown, store?: JobStore): CommandError {
  if (error instanceof ProvisionHalt) return programErrorToCommandError(error.error, store);
  if (error instanceof PlanRefused) return programErrorToCommandError(error.error, store);
  if (error instanceof JobExistsError) {
    return new CommandError("E_IDEMPOTENCY_CONFLICT", `${error.message}. Nothing was written by this run.`, `Run the same command again to resume job ${error.jobId}. Never run two provisioning processes for one name at once.`);
  }
  return toCommandError(error);
}

export type JobSummary = {
  jobId: string;
  name: string;
  owner: Address;
  chain: string;
  state: string;
  identity: string;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  resumable: boolean | null;
  resumeFrom: string | null;
  blockedBy: string | null;
  nextAction: string | null;
  transactions: number;
  path: string | null;
};

export function summarize(file: JobFile, store: JobStore): JobSummary {
  const j = file.job;
  return {
    jobId: j.jobId,
    name: j.facts.normalizedName,
    owner: j.facts.owner,
    chain: j.chain,
    state: j.state,
    identity: j.identity,
    agentId: j.facts.erc8004AgentId ?? null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    resumable: j.resume?.resumable ?? null,
    resumeFrom: j.resume?.resumeFromStep ?? null,
    blockedBy: j.resume?.blockedBy?.code ?? null,
    nextAction: j.resume?.nextAction ?? null,
    transactions: j.steps.reduce((n, s) => n + (s.receipts?.filter((r) => r.receiptStatus === "success").length ?? 0), 0),
    path: store.location(j.jobId),
  };
}

/** Human-units formatting for the intent's spend ceiling. */
export async function formatSpend(client: PublicClient, d: EnsV2Deployment, units: string): Promise<{ total: string; symbol: string; decimals: number }> {
  const tok = { address: d.paymentToken, abi: erc20Abi } as const;
  const [symbol, decimals] = await Promise.all([client.readContract({ ...tok, functionName: "symbol" }), client.readContract({ ...tok, functionName: "decimals" })]);
  return { total: formatUnits(BigInt(units), decimals), symbol, decimals };
}
