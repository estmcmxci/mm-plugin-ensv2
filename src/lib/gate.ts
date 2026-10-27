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
  MAINNET_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  defaultDeploymentForChain,
  deploymentByKey,
  deploymentFor,
  deploymentsOnChain,
  deploymentsWithAgentIdentity,
  hasAgentIdentity,
  isDeploymentKey,
  type DeploymentKey,
  type EnsV2Deployment,
  type EnsV2DeploymentWithIdentity,
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
 *   3. `sepolia` — ENS Labs' canonical ENSv2 testnet deployment
 *
 * An unknown name is a refusal, never a silent fallback to the default: a
 * typo'd `--deployment mainnnet` must not quietly transact anywhere, least of
 * all somewhere that spends real USDC.
 *
 * Prefer `resolveTarget`, which settles the chain and the deployment together.
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
    `Pass one of: ${DEPLOYMENT_KEYS.join(", ")}. \`sepolia\` is ENS Labs' canonical testnet deployment and the default; \`mainnet\` is ENSv2 on Ethereum L1 and spends real USDC; \`hackathon\` is the ETHOnline deployment; \`beta\` is the dead original, kept only so old jobs resolve.`,
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
      `Omit --chain — naming a deployment is enough, it implies its own chain — or pass --chain ${known.chainId}.`,
    );
  }
  throw unsupportedChain(chainId);
}

/**
 * "Nothing is pinned for this chain" — the refusal for a chain the plugin has
 * no table on. Distinct from the cross-chain refusal above, which names a
 * deployment: when the caller named only a chain, blaming a deployment they
 * never mentioned (and telling them to drop the flag they did use) sends them
 * the wrong way entirely.
 */
export function unsupportedChain(chainId: number): CommandError {
  const available = deploymentsOnChain(chainId).map((x) => x.key);
  return new CommandError(
    "ENSV2_UNSUPPORTED_CHAIN",
    `No ENSv2 deployment is configured for chain ${chainId}.`,
    available.length
      ? `On this chain the plugin knows: ${available.join(", ")}.`
      : `The plugin pins ENSv2 on Ethereum mainnet (chain ${MAINNET_CHAIN_ID}) and Sepolia (chain ${SEPOLIA_CHAIN_ID}). No other chain has an ENSv2 deployment to talk to.`,
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

/**
 * Settle the chain and the deployment together — the one place that decides
 * what this invocation talks to. Every command calls it with its raw
 * `--chain` and `--deployment` values.
 *
 *   both named      -> both honoured; `requireDeployment` then refuses an
 *                      incoherent pair rather than preferring one
 *   deployment only -> the deployment's OWN chain, so `--deployment mainnet`
 *                      needs no `--chain 1`
 *   chain only      -> that chain's canonical deployment
 *                      (`DEFAULT_DEPLOYMENT_FOR_CHAIN`), so `--chain 1` needs
 *                      no `--deployment mainnet`
 *   neither         -> `DEFAULT_DEPLOYMENT_KEY` and its chain: Sepolia
 *
 * Deliberately not symmetric with a "nearest match": an unknown chain with no
 * pinned deployment is a refusal, not a silent fallback to Sepolia.
 */
export function resolveTarget(
  chainRaw: string | undefined,
  deploymentRaw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { chainId: number; deploymentKey: DeploymentKey; deployment: EnsV2Deployment } {
  const selection = deploymentSelection(deploymentRaw, env);
  const chainNamed = chainRaw != null && chainRaw !== "";

  if (!chainNamed) {
    // A named deployment implies its chain; otherwise the default's chain.
    const d = deploymentByKey(selection.key)!;
    return { chainId: d.chainId, deploymentKey: d.key, deployment: d };
  }

  const chainId = parseChainId(chainRaw);
  if (!selection.explicit) {
    const canonical = defaultDeploymentForChain(chainId);
    if (canonical) return { chainId, deploymentKey: canonical.key, deployment: canonical };
    // Only a chain was named, and nothing is pinned on it. Refuse for THAT
    // reason: `requireDeployment` would name the default deployment and tell
    // the caller to drop the one flag they actually passed.
    throw unsupportedChain(chainId);
  }
  return { chainId, deploymentKey: selection.key, deployment: requireDeployment(chainId, selection.key) };
}

/**
 * Narrow to a deployment that can actually mint and bind an ERC-8004 agent, or
 * refuse by name.
 *
 * Mainnet pins no Adapter8004 — unruggable-labs has not deployed it to chain 1
 * (checked 2026-10-27) — so `agent register`, `agent info` and `agent set-uri`
 * have nothing to call there. Refusing with the reason beats carrying a zero
 * address into a mint.
 */
export function requireAgentIdentity(d: EnsV2Deployment): EnsV2DeploymentWithIdentity {
  if (hasAgentIdentity(d)) return d;
  const elsewhere = deploymentsWithAgentIdentity().map((x) => x.key);
  throw new CommandError(
    "ENSV2_NO_AGENT_IDENTITY",
    `Deployment '${d.key}' (chain ${d.chainId}) has no Adapter8004, so an ERC-8004 agent cannot be minted, bound or inspected there.`,
    elsewhere.length
      ? `Agent identity works on: ${elsewhere.join(", ")}. Everything else about this deployment — names, records, resolvers, primary names — works normally.`
      : "No pinned deployment has the adapter.",
  );
}

/**
 * The deployment's canonical ERC-8004 IdentityRegistry, or a refusal. This is
 * a weaker requirement than `requireAgentIdentity`: the registry is live on
 * mainnet even though the binding adapter is not, so ENSIP-25 record keys
 * derive and read on chain 1.
 */
export function requireIdentityRegistry(d: EnsV2Deployment): `0x${string}` {
  if (d.identityRegistry) return d.identityRegistry;
  throw new CommandError(
    "ENSV2_NO_IDENTITY_REGISTRY",
    `Deployment '${d.key}' (chain ${d.chainId}) pins no ERC-8004 identity registry.`,
    "An ENSIP-25 agent-registration key is derived from that registry's address; there is nothing to derive it from here.",
  );
}

export function toCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof ReadError) return new CommandError(error.code, error.message, error.hint ?? "See --verbose for detail.");
  const msg = error instanceof Error ? error.message.split("\n")[0]! : String(error);
  return new CommandError("ENSV2_RPC_ERROR", `ENSv2 lookup failed: ${msg}`, "Check the RPC endpoint and try again.");
}
