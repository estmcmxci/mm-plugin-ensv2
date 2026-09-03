import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import type { Check } from "../../lib/ensv2.js";
import { parseChainId, requireEnsV2, toCommandError } from "../../lib/gate.js";

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
 * ENSv1 behaviour. Every other command in this plugin runs the same gate
 * (`requireEnsV2`) before doing anything.
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
    const chainId = parseChainId(chain);
    // Host client carries no `chain`; every read passes an explicit address.
    const client = this.ctx.publicClient(chainId);

    try {
      const { detection } = await requireEnsV2(client, chainId);
      return {
        chainId: detection.chainId,
        isV2: true,
        universalResolver: detection.universalResolver,
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
    return `ENSv2 active on chain ${data.chainId} — .eth registry ${data.ethRegistry}, ${passed}/${data.checks.length} checks passed`;
  }
}
