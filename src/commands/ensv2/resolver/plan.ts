import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, requireEnsV2, toCommandError } from "../../../lib/gate.js";
import { buildDeployPlan, ownedResolverStatus, type OwnedResolverStatus } from "../../../lib/resolver.js";
import { selectedEvmAddress } from "../../../lib/wallet.js";

const inputs = {
  chain: {
    type: InputFieldType.Text,
    flag: "chain",
    message: "EVM chain id (default 11155111, Sepolia)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

export type ResolverPlanResult = OwnedResolverStatus & {
  /** Unsigned calldata `resolver deploy` would submit. Null when the resolver already exists. */
  plan: { to: string; data: string; value: string; initData: string; roleBitmap: string } | null;
};

/**
 * `mm ensv2 resolver plan` — where this wallet's ENSv2 resolver is (or will
 * be), whether it exists yet, and the exact calldata `resolver deploy` would
 * hand to the wallet. Read-only; nothing is signed or sent.
 */
export default class EnsV2ResolverPlan extends PluginCommand<ResolverPlanResult> {
  static override description =
    "Predict this wallet's ENSv2 resolver address and show the deploy calldata. Read-only; sends nothing.";

  static override examples = ["<%= config.bin %> ensv2 resolver plan", "<%= config.bin %> ensv2 resolver plan --json"];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:resolver:plan";

  async execute(io: CommandIO): Promise<ResolverPlanResult> {
    const { chain } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment } = await requireEnsV2(client, chainId);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      const status = await ownedResolverStatus(client, deployment, owner);
      const plan = status.deployed ? null : buildDeployPlan(deployment, status);
      return {
        ...status,
        plan: plan ? { to: plan.to, data: plan.data, value: "0", initData: plan.initData, roleBitmap: plan.roleBitmap } : null,
      };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: ResolverPlanResult): string {
    return d.deployed
      ? `Resolver already deployed at ${d.predicted}${d.verified ? " (factory-verified)" : " — WARNING: factory does not attest this proxy"}`
      : `Resolver would deploy at ${d.predicted} — run \`ensv2 resolver deploy\``;
  }
}
