import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { SEPOLIA_CHAIN_ID, deploymentForChain } from "../../lib/deployments.js";
import { type Check, detectEnsV2 } from "../../lib/ensv2.js";

const inputs = {
  chain: {
    type: InputFieldType.Text,
    flag: "chain",
    message: "EVM chain id (default 11155111, Sepolia)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

type StatusResult = {
  chainId: number;
  isV2: boolean;
  universalResolver: string;
  ethRegistry: string | null;
  rootRegistry: string | null;
  checks: Check[];
};

/**
 * `mm ensv2 status` — is this chain serving ENSv2, and does our deployment
 * table agree with it?
 *
 * Fails closed. A non-ENSv2 answer exits non-zero rather than degrading to
 * ENSv1 behaviour. Every write command in this plugin runs this check first.
 */
export default class EnsV2Status extends PluginCommand<StatusResult> {
  static override description =
    "Verify the chain is serving ENSv2 and the configured deployment matches it. Refuses (non-zero) otherwise.";

  static override examples = [
    "<%= config.bin %> ensv2 status",
    "<%= config.bin %> ensv2 status --json",
    "<%= config.bin %> ensv2 status --chain 11155111",
  ];

  // Needs the host's authenticated per-chain RPC client (wallet-read).
  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:status";

  async execute(io: CommandIO): Promise<StatusResult> {
    const { chain } = await io.resolveInputs(inputs);
    const chainId = chain ? Number(chain) : SEPOLIA_CHAIN_ID;
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new CommandError("ENSV2_INVALID_CHAIN", `'${chain}' is not a chain id.`, "Pass a numeric EVM chain id, e.g. 11155111 for Sepolia.");
    }

    const deployment = deploymentForChain(chainId);
    if (!deployment) {
      throw new CommandError(
        "ENSV2_UNSUPPORTED_CHAIN",
        `No ENSv2 deployment is configured for chain ${chainId}.`,
        "ENSv2 is a Sepolia beta (chain 11155111). Mainnet stays disabled until a canonical production deployment exists.",
      );
    }

    // Host client carries no `chain`; detectEnsV2 passes explicit addresses on every call.
    const client = this.ctx.publicClient(chainId);
    const result = await detectEnsV2(client, deployment);

    if (!result.isV2) {
      const failed = result.checks.find((c) => !c.ok);
      throw new CommandError(
        "ENSV2_NOT_ACTIVE",
        `ENSv2 is not active on chain ${chainId}: ${result.reason}.` +
          (failed ? ` Failed: ${failed.name} (expected ${failed.expected}, got ${failed.actual}).` : ""),
        "Refusing to continue rather than falling back to ENSv1. Check the RPC endpoint and the deployment table.",
      );
    }

    return {
      chainId: result.chainId,
      isV2: true,
      universalResolver: result.universalResolver,
      ethRegistry: result.ethRegistry,
      rootRegistry: result.rootRegistry,
      checks: [...result.checks],
    };
  }

  override successHint(data: StatusResult): string {
    const passed = data.checks.filter((c) => c.ok).length;
    return `ENSv2 active on chain ${data.chainId} — .eth registry ${data.ethRegistry}, ${passed}/${data.checks.length} checks passed`;
  }
}
