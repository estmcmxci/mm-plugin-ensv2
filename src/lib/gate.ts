/**
 * The fail-closed gate every command runs first, and the error mapping from
 * lib errors to host CommandErrors. This is the only lib module that imports
 * the plugin SDK; keep it that way so reads.ts / ensv2.ts stay runnable
 * without the host.
 */
import { CommandError } from "@metamask/agent-wallet/plugin";
import type { PublicClient } from "viem";
import {
  DEFAULT_DEPLOYMENT_KEY,
  DEPLOYMENT_KEYS,
  SEPOLIA_CHAIN_ID,
  deploymentByKey,
  deploymentFor,
  deploymentsOnChain,
  isDeploymentKey,
  type DeploymentKey,
  type EnsV2Deployment,
} from "./deployments.js";
import { detectEnsV2, type EnsV2Detection } from "./ensv2.js";
import { ReadError } from "./reads.js";

export type ActiveEnsV2 = Extract<EnsV2Detection, { isV2: true }>;

/** The environment variable consulted when `--deployment` is not given. */
export const DEPLOYMENT_ENV_VAR = "MM_ENSV2_DEPLOYMENT";

export function parseChainId(raw: string | undefined): number {
  if (raw == null || raw === "") return SEPOLIA_CHAIN_ID;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError("ENSV2_INVALID_CHAIN", `'${raw}' is not a chain id.`, "Pass a numeric EVM chain id, e.g. 11155111 for Sepolia.");
  }
  return n;
}

/**
 * Which pinned deployment this invocation talks to. Precedence, highest first:
 *
 *   1. the `--deployment` flag
 *   2. the MM_ENSV2_DEPLOYMENT environment variable
 *   3. `beta` — the canonical ENSv2 Sepolia beta, unchanged from v0.7.2
 *
 * An unknown name is a refusal, never a silent fallback to the default: a
 * typo'd `--deployment hackaton` must not quietly transact against the beta.
 */
export function parseDeploymentKey(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): DeploymentKey {
  return deploymentSelection(raw, env).key;
}

/**
 * As `parseDeploymentKey`, but also reports whether the user actually chose —
 * and where. The purely local `jobs list` uses this to filter only when a
 * deployment was named, so its default output still shows every job on the
 * machine rather than silently hiding the other deployment's.
 */
export function deploymentSelection(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { key: DeploymentKey; explicit: boolean; source: "flag" | "env" | "default" } {
  const flag = raw?.trim();
  if (flag) return { key: checkedDeploymentKey(flag, "--deployment"), explicit: true, source: "flag" };
  const fromEnv = env[DEPLOYMENT_ENV_VAR]?.trim();
  if (fromEnv) return { key: checkedDeploymentKey(fromEnv, DEPLOYMENT_ENV_VAR), explicit: true, source: "env" };
  return { key: DEFAULT_DEPLOYMENT_KEY, explicit: false, source: "default" };
}

function checkedDeploymentKey(value: string, source: string): DeploymentKey {
  if (isDeploymentKey(value)) return value;
  throw new CommandError(
    "ENSV2_UNKNOWN_DEPLOYMENT",
    `'${value}' (from ${source}) is not a known ENSv2 deployment.`,
    `Pass one of: ${DEPLOYMENT_KEYS.join(", ")}. \`beta\` is the canonical Sepolia beta and the default; \`hackathon\` is ENS Labs' dedicated ETHOnline deployment.`,
  );
}

/**
 * The pinned table for (chainId, deployment). Refuses an unsupported chain,
 * and refuses a deployment that does not live on the chain asked for — the two
 * failures have different fixes, so they carry different hints.
 */
export function requireDeployment(chainId: number, deploymentKey: DeploymentKey = DEFAULT_DEPLOYMENT_KEY): EnsV2Deployment {
  const d = deploymentFor(chainId, deploymentKey);
  if (d) return d;
  const known = deploymentByKey(deploymentKey);
  if (known) {
    throw new CommandError(
      "ENSV2_UNSUPPORTED_CHAIN",
      `Deployment '${deploymentKey}' is on chain ${known.chainId}, not ${chainId}.`,
      `Omit --chain (it defaults to ${known.chainId}) or pass --chain ${known.chainId}.`,
    );
  }
  const available = deploymentsOnChain(chainId).map((x) => x.key);
  throw new CommandError(
    "ENSV2_UNSUPPORTED_CHAIN",
    `No ENSv2 deployment is configured for chain ${chainId}.`,
    available.length
      ? `On this chain the plugin knows: ${available.join(", ")}.`
      : "ENSv2 is a Sepolia beta (chain 11155111). Mainnet stays disabled until a canonical production deployment exists.",
  );
}

/**
 * Refuses — throws — unless the chain is verifiably serving the ENSv2
 * generation this deployment claims, and the deployment table agrees with it.
 * A table of one generation can never be accepted against the other's
 * contracts (see ensv2.ts).
 */
export async function requireEnsV2(
  client: PublicClient,
  chainId: number,
  deploymentKey: DeploymentKey = DEFAULT_DEPLOYMENT_KEY,
): Promise<{ deployment: EnsV2Deployment; detection: ActiveEnsV2 }> {
  const deployment = requireDeployment(chainId, deploymentKey);
  const detection = await detectEnsV2(client, deployment);
  if (!detection.isV2) {
    const failed = detection.checks.find((c) => !c.ok);
    throw new CommandError(
      "ENSV2_NOT_ACTIVE",
      `ENSv2 (${deployment.key}, generation ${deployment.generation}) is not active on chain ${chainId}: ${detection.reason}.` +
        (failed ? ` Failed: ${failed.name} (expected ${failed.expected}, got ${failed.actual}).` : ""),
      "Refusing to continue rather than falling back to ENSv1 or to another deployment. Check the RPC endpoint and the deployment table.",
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
