import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, parseDeploymentKey, requireEnsV2, toCommandError } from "../../../lib/gate.js";
import { planSetPrimary, primaryStatus } from "../../../lib/primary.js";
import { selectedEvmAddress } from "../../../lib/wallet.js";

const inputs = {
  name: { type: InputFieldType.Text, flag: "name", message: "ENS name to make this wallet's primary name (must already resolve to this wallet)", required: true, index: 0 },
  chain: { type: InputFieldType.Text, flag: "chain", message: "EVM chain id (default 11155111, Sepolia)", required: false, prompt: false },
  deployment: { type: InputFieldType.Text, flag: "deployment", message: "ENSv2 deployment: beta (default, the canonical Sepolia beta) or hackathon (ENS Labs' ETHOnline deployment, a newer contract generation)", required: false, prompt: false },
} satisfies InputSchema;

type PrimarySetResult = {
  chainId: number;
  owner: string;
  name: string;
  reverseRegistrar: string;
  /** How the registrar was found: root → reverse TLD resolver → v1 registry → owner(addr.reverse). */
  derivedVia: { reverseTldResolver: string; v1Registry: string };
  alreadySet: boolean;
  txHash: string | null;
  /** UR.reverse(owner) == name after the write. */
  verified: boolean;
};

/**
 * `mm ensv2 primary set <name>` — make <name> this wallet's primary name by
 * calling the v1 ReverseRegistrar.setName(name) from the wallet (the reverse
 * namespace is v1 infrastructure at ENSv2 launch; see lib/primary.ts).
 *
 * Refuses unless the registrar derived from the v2 root matches the table
 * and the name already resolves to this wallet. No-op if already set.
 * Verifies the round-trip through the Universal Resolver afterwards.
 */
export default class EnsV2PrimarySet extends PluginCommand<PrimarySetResult> {
  static override description = "Set this wallet's primary ENS name (reverse record), one tx. The name must already resolve to this wallet.";

  static override examples = ["<%= config.bin %> ensv2 primary set myagent.eth", "<%= config.bin %> ensv2 primary get"];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:primary:set";

  async execute(io: CommandIO): Promise<PrimarySetResult> {
    const v = await io.resolveInputs(inputs);
    const chainId = parseChainId(v.chain);
    const deploymentKey = parseDeploymentKey(v.deployment);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment: d } = await requireEnsV2(client, chainId, deploymentKey);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      const plan = await planSetPrimary(client, d, chainId, owner, v.name);
      const base = {
        chainId,
        owner,
        name: plan.name,
        reverseRegistrar: plan.status.infra.reverseRegistrar,
        derivedVia: { reverseTldResolver: plan.status.infra.reverseTldResolver, v1Registry: plan.status.infra.v1Registry },
      };
      if (!plan.calldata) return { ...base, alreadySet: true, txHash: null, verified: true };

      const execute = await this.ctx.walletExecutor(io, "ensv2:primary:set");
      const result = await execute(
        {
          kind: "transaction",
          chainId,
          transaction: { to: plan.calldata.to, data: plan.calldata.data, value: plan.calldata.value },
          intent: {
            summary: `Set ${plan.name} as the primary name of ${owner}`,
            action: "call",
            details: { reverseRegistrar: plan.calldata.to, name: plan.name, previous: plan.status.rawName ?? "(none)", chain: `Sepolia (${chainId})` },
          },
        },
        { waitForReceipt: true },
      );
      if (result.kind !== "transaction" || result.failureCode) {
        throw new CommandError(
          "ENSV2_PRIMARY_FAILED",
          `setName failed: ${result.kind === "transaction" ? (result.failureDescription ?? result.failureCode) : "non-transaction result"}`,
          "Nothing changed. Fix the cause and re-run; the command is idempotent.",
        );
      }

      const after = await primaryStatus(client, d, chainId, owner);
      const verified = after.functional && after.primaryName === plan.name;
      if (!verified) {
        throw new CommandError(
          "ENSV2_PRIMARY_UNVERIFIED",
          `tx ${result.hash} landed but the Universal Resolver reports ${after.primaryName ?? "no primary name"} for ${owner} (reverse record says ${after.rawName ?? "nothing"}).`,
          "Wait a block and run `ensv2 primary get`. If it persists, the forward record may have changed.",
        );
      }
      return { ...base, alreadySet: false, txHash: result.hash, verified };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: PrimarySetResult): string {
    return d.alreadySet
      ? `${d.name} is already the primary name of ${d.owner} — nothing to do`
      : `${d.owner} → ${d.name}: primary name set (tx ${d.txHash}), round-trip verified via the Universal Resolver`;
  }
}
