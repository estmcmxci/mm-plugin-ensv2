/**
 * The fail-closed gate every command runs first, and the error mapping from
 * lib errors to host CommandErrors. This is the only lib module that imports
 * the plugin SDK; keep it that way so reads.ts / ensv2.ts stay runnable
 * without the host.
 */
import { CommandError } from "@metamask/agent-wallet/plugin";
import type { PublicClient } from "viem";
import { SEPOLIA_CHAIN_ID, deploymentForChain, type EnsV2Deployment } from "./deployments.js";
import { detectEnsV2, type EnsV2Detection } from "./ensv2.js";
import { ReadError } from "./reads.js";

export type ActiveEnsV2 = Extract<EnsV2Detection, { isV2: true }>;

export function parseChainId(raw: string | undefined): number {
  if (raw == null || raw === "") return SEPOLIA_CHAIN_ID;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError("ENSV2_INVALID_CHAIN", `'${raw}' is not a chain id.`, "Pass a numeric EVM chain id, e.g. 11155111 for Sepolia.");
  }
  return n;
}

export function requireDeployment(chainId: number): EnsV2Deployment {
  const d = deploymentForChain(chainId);
  if (!d) {
    throw new CommandError(
      "ENSV2_UNSUPPORTED_CHAIN",
      `No ENSv2 deployment is configured for chain ${chainId}.`,
      "ENSv2 is a Sepolia beta (chain 11155111). Mainnet stays disabled until a canonical production deployment exists.",
    );
  }
  return d;
}

/** Refuses — throws — unless the chain is verifiably serving ENSv2 and the deployment table agrees with it. */
export async function requireEnsV2(client: PublicClient, chainId: number): Promise<{ deployment: EnsV2Deployment; detection: ActiveEnsV2 }> {
  const deployment = requireDeployment(chainId);
  const detection = await detectEnsV2(client, deployment);
  if (!detection.isV2) {
    const failed = detection.checks.find((c) => !c.ok);
    throw new CommandError(
      "ENSV2_NOT_ACTIVE",
      `ENSv2 is not active on chain ${chainId}: ${detection.reason}.` +
        (failed ? ` Failed: ${failed.name} (expected ${failed.expected}, got ${failed.actual}).` : ""),
      "Refusing to continue rather than falling back to ENSv1. Check the RPC endpoint and the deployment table.",
    );
  }
  return { deployment, detection };
}

export function toCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof ReadError) return new CommandError(error.code, error.message, error.hint ?? "See --verbose for detail.");
  const msg = error instanceof Error ? error.message.split("\n")[0]! : String(error);
  return new CommandError("ENSV2_RPC_ERROR", `ENSv2 lookup failed: ${msg}`, "Check the RPC endpoint and try again.");
}
