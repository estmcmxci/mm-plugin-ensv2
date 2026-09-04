import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import type { Check } from "../../lib/ensv2.js";
import { parseChainId, parseDeploymentKey, requireEnsV2, toCommandError } from "../../lib/gate.js";

const inputs = {
  chain: {
    type: InputFieldType.Text,
    flag: "chain",
    message: "EVM chain id (default 11155111, Sepolia)",
    required: false,
    prompt: false,
  },
  deployment: {
    type: InputFieldType.Text,
    flag: "deployment",
    message: "ENSv2 deployment: beta (default, the canonical Sepolia beta) or hackathon (ENS Labs' ETHOnline deployment, a newer contract generation)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

type StatusResult = {
  chainId: number;
  /** Which pinned deployment was checked: `beta` (default) or `hackathon`. */
  deployment: string;
  /** Its stable identifier, as carried on every job, receipt and verification result. */
  deploymentId: string;
  /** Contract generation: g1 (beta) or g2 (hackathon). Decides which gate ran. */
  generation: string;
  isV2: boolean;
  universalResolver: string;
  /** g2 only: where registry navigation lives on this generation. null on g1. */
  universalHelper: string | null;
  ethRegistry: string | null;
  rootRegistry: string | null;
  checks: Check[];
};

/**
 * `mm ensv2 status` — is this chain serving ENSv2, and does our deployment
 * table agree with it?
 *
 * Fails closed. A non-ENSv2 answer exits non-zero rather than degrading to
 * ENSv1 behaviour. Every other command in this plugin runs the same gate
 * (`requireEnsV2`) before doing anything.
 *
 * `--deployment` picks which pinned table to check. The gate is
 * generation-aware and never cross-accepts: `--deployment beta` refuses the
 * hackathon contracts and vice versa.
 */
export default class EnsV2Status extends PluginCommand<StatusResult> {
  static override description =
    "Verify the chain is serving ENSv2 and the configured deployment matches it. Refuses (non-zero) otherwise.";

  static override examples = [
    "<%= config.bin %> ensv2 status",
    "<%= config.bin %> ensv2 status --json",
    "<%= config.bin %> ensv2 status --deployment hackathon",
    "<%= config.bin %> ensv2 status --chain 11155111",
  ];

  // Needs the host's authenticated per-chain RPC client (wallet-read).
  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:status";

  async execute(io: CommandIO): Promise<StatusResult> {
    const { chain, deployment: deploymentFlag } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const deploymentKey = parseDeploymentKey(deploymentFlag);
    // Host client carries no `chain`; every read passes an explicit address.
    const client = this.ctx.publicClient(chainId);

    try {
      const { deployment: d, detection } = await requireEnsV2(client, chainId, deploymentKey);
      return {
        chainId: detection.chainId,
        deployment: d.key,
        deploymentId: d.deploymentId,
        generation: d.generation,
        isV2: true,
        universalResolver: detection.universalResolver,
        universalHelper: d.universalHelper ?? null,
        ethRegistry: detection.ethRegistry,
        rootRegistry: detection.rootRegistry,
        checks: [...detection.checks],
      };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(data: StatusResult): string {
    const passed = data.checks.filter((c) => c.ok).length;
    return `ENSv2 active on chain ${data.chainId} — deployment ${data.deployment} (${data.deploymentId}, ${data.generation}), .eth registry ${data.ethRegistry}, ${passed}/${data.checks.length} checks passed`;
  }
}
