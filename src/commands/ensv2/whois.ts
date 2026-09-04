import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, parseDeploymentKey, requireEnsV2, toCommandError } from "../../lib/gate.js";
import { whois, type WhoisInfo } from "../../lib/reads.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "ENSv2 name (e.g. name.eth or sub.name.eth)",
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
 * `mm ensv2 whois <name>` — registration state straight from the registry
 * that holds the name: status, expiry, owner, current token id, the stable
 * canonical id, the registration epoch, resolver and subregistry.
 *
 * Reports `owner` only while REGISTERED — `latestOwner` is stale after
 * expiry. Reports the token id but warns it is not stable; the epoch is the
 * durable anchor.
 */
export default class EnsV2Whois extends PluginCommand<WhoisInfo> {
  static override description =
    "Show an ENSv2 name's registration state from the registry that holds it. Refuses if the chain is not serving ENSv2.";

  static override examples = [
    "<%= config.bin %> ensv2 whois name.eth",
    "<%= config.bin %> ensv2 whois sub.name.eth",
    "<%= config.bin %> ensv2 whois name.eth --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:whois";

  async execute(io: CommandIO): Promise<WhoisInfo> {
    const { name, chain, deployment: deploymentFlag } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const deploymentKey = parseDeploymentKey(deploymentFlag);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment } = await requireEnsV2(client, chainId, deploymentKey);
      return await whois(client, deployment, name);
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(data: WhoisInfo): string {
    const parts = [`${data.name} — ${data.status}`];
    if (data.owner) parts.push(`owner ${data.owner}`);
    if (data.expiresAt) parts.push(`${data.status === "REGISTERED" ? "expires" : "expired"} ${data.expiresAt.slice(0, 10)}`);
    if (data.status === "REGISTERED") parts.push(data.resolver ? `resolver ${data.resolver}` : "no resolver");
    return parts.join(", ");
  }
}
