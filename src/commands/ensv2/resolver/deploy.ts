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
import { buildDeployPlan, ownedResolverStatus } from "../../../lib/resolver.js";
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

type DeployResult = {
  chainId: number;
  owner: string;
  resolver: string;
  factory: string;
  implementation: string;
  alreadyDeployed: boolean;
  txHash: string | null;
  txStatus: string | null;
  /** VerifiableFactory attests this proxy runs the configured implementation. */
  verified: boolean;
};

/**
 * `mm ensv2 resolver deploy` — deploy this wallet's ENSv2 PermissionedResolver
 * through the VerifiableFactory. One per wallet, ever: if it already exists
 * the command is a no-op and exits 0.
 *
 * Flow: gate → predict address (proxyLogic read from chain) → no-op if code
 * exists → build deployProxy calldata → hand {to, data, value: 0} to the host
 * wallet executor (MetaMask policy signs; the plugin never sees a key) → wait
 * for receipt → re-read chain and require the factory to attest the proxy.
 *
 * The transaction is sent from the wallet's own account, which is also the
 * admin and the salt owner — the only configuration under which the predicted
 * address is guaranteed to be the deployed one.
 */
export default class EnsV2ResolverDeploy extends PluginCommand<DeployResult> {
  static override description =
    "Deploy this wallet's ENSv2 resolver (once per wallet; no-op if it exists). Signs through MetaMask policy.";

  static override examples = [
    "<%= config.bin %> ensv2 resolver plan     # preview first",
    "<%= config.bin %> ensv2 resolver deploy",
    "<%= config.bin %> ensv2 resolver deploy --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:resolver:deploy";

  async execute(io: CommandIO): Promise<DeployResult> {
    const { chain } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const client = this.ctx.publicClient(chainId);

    try {
      const { deployment } = await requireEnsV2(client, chainId);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      const before = await ownedResolverStatus(client, deployment, owner);
      if (!before.proxyLogicMatchesConfig) {
        throw new CommandError(
          "ENSV2_FACTORY_MISMATCH",
          `VerifiableFactory.proxyLogic() is ${before.proxyLogic}, configured ${deployment.resolverProxyLogic}.`,
          "The predicted address would be wrong. Refusing to deploy against a factory the deployment table disagrees with.",
        );
      }

      const base = { chainId, owner, factory: before.factory, implementation: before.implementation };

      if (before.deployed) {
        return { ...base, resolver: before.predicted, alreadyDeployed: true, txHash: null, txStatus: null, verified: before.verified === true };
      }

      const plan = buildDeployPlan(deployment, before);
      const execute = await this.ctx.walletExecutor(io, "ensv2:resolver:deploy");
      const result = await execute(
        {
          kind: "transaction",
          chainId,
          transaction: { to: plan.to, data: plan.data, value: 0n },
          intent: {
            summary: `Deploy your ENSv2 resolver at ${plan.predicted}`,
            action: "call",
            details: { factory: plan.to, resolver: plan.predicted, admin: owner, chain: `Sepolia (${chainId})` },
          },
        },
        { waitForReceipt: true },
      );

      if (result.kind !== "transaction") {
        throw new CommandError("ENSV2_DEPLOY_FAILED", "Wallet returned a non-transaction result.", "Report this; the executor contract changed.");
      }
      if (result.failureCode) {
        throw new CommandError(
          "ENSV2_DEPLOY_FAILED",
          `Deployment failed: ${result.failureDescription ?? result.failureCode}${result.hash ? ` (tx ${result.hash})` : ""}`,
          "Nothing was deployed. The command is idempotent; fix the cause and re-run.",
        );
      }

      // Never trust the executor's word for it — prove it on chain.
      const after = await ownedResolverStatus(client, deployment, owner);
      if (!after.deployed) {
        throw new CommandError(
          "ENSV2_DEPLOY_PENDING",
          `Transaction ${result.hash} reported status "${result.status}" but no code exists at ${plan.predicted} yet.`,
          "If the request is awaiting approval, complete it (see `mm wallet requests list`) and re-run; the command is idempotent.",
        );
      }
      if (after.verified !== true) {
        throw new CommandError(
          "ENSV2_DEPLOY_UNVERIFIED",
          `Code exists at ${after.predicted} but VerifiableFactory does not attest it runs ${deployment.resolverImplementation}.`,
          "Do not use this resolver. Report this with the transaction hash: " + result.hash,
        );
      }

      return { ...base, resolver: after.predicted, alreadyDeployed: false, txHash: result.hash, txStatus: result.status, verified: true };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: DeployResult): string {
    return d.alreadyDeployed
      ? `Resolver already deployed at ${d.resolver}${d.verified ? " (factory-verified)" : ""} — nothing to do`
      : `Resolver deployed at ${d.resolver} (factory-verified), tx ${d.txHash}`;
  }
}
