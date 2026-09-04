import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, parseDeploymentKey, requireEnsV2, toCommandError } from "../../lib/gate.js";
import { checkAvailable, type Availability } from "../../lib/registrar.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Label or 2LD name to check (e.g. myagent or myagent.eth)",
    required: true,
    index: 0,
  },
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

/**
 * `mm ensv2 available <name>` — can this .eth label be registered right now?
 * Asks the ETHRegistrar, which is the only contract that knows: it accounts
 * for grace periods and for ENSv1 names reserved by pre-migration.
 */
export default class EnsV2Available extends PluginCommand<Availability> {
  static override description = "Check whether a .eth label is available to register on ENSv2. Refuses if the chain is not serving ENSv2.";

  static override examples = ["<%= config.bin %> ensv2 available myagent", "<%= config.bin %> ensv2 available myagent.eth --json"];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:available";

  async execute(io: CommandIO): Promise<Availability> {
    const { name, chain, deployment: deploymentFlag } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const deploymentKey = parseDeploymentKey(deploymentFlag);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment } = await requireEnsV2(client, chainId, deploymentKey);
      return await checkAvailable(client, deployment, name);
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: Availability): string {
    return d.available
      ? `${d.name} is available — minimum ${d.minRegisterDuration / 86400} days, commit-to-register window ${d.minCommitmentAge}s–${d.maxCommitmentAge / 3600}h`
      : `${d.name} is not available (registered, in grace, or reserved from ENSv1)`;
  }
}
