import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, requireEnsV2, toCommandError } from "../../lib/gate.js";
import { resolverInfo, type ResolverInfo } from "../../lib/reads.js";

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
} satisfies InputSchema;

/**
 * `mm ensv2 resolver <name>` — which resolver answers for a name, and whether
 * it is the name's own (offset 0), inherited from an ancestor suffix, or
 * absent. Cross-checks the Universal Resolver's answer against the holding
 * registry's own entry.
 *
 * "None" is a valid answer, not an error: on ENSv2 a freshly registered name
 * has no resolver until one is deployed and assigned (see `resolver deploy`).
 */
export default class EnsV2Resolver extends PluginCommand<ResolverInfo> {
  static override description =
    "Show which resolver answers for an ENSv2 name — its own, an ancestor's, or none. Refuses if the chain is not serving ENSv2.";

  static override examples = [
    "<%= config.bin %> ensv2 resolver name.eth",
    "<%= config.bin %> ensv2 resolver sub.name.eth --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:resolver";

  async execute(io: CommandIO): Promise<ResolverInfo> {
    const { name, chain } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment } = await requireEnsV2(client, chainId);
      return await resolverInfo(client, deployment, name);
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(data: ResolverInfo): string {
    switch (data.kind) {
      case "own":
        return `${data.name} → ${data.resolver} (own resolver${data.consistent === false ? "; registry entry DISAGREES" : ""})`;
      case "inherited":
        return `${data.name} → ${data.resolver} (inherited from ${data.inheritedFrom})`;
      case "none":
        return `${data.name} has no resolver${data.registry ? "" : " and no registry holds it"}`;
    }
  }
}
