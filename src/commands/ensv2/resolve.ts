import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, requireEnsV2, toCommandError } from "../../lib/gate.js";
import { resolveQuery, type ResolveResult } from "../../lib/reads.js";

const inputs = {
  query: {
    type: InputFieldType.Text,
    flag: "query",
    message: "ENSv2 name (e.g. name.eth) or 0x address to reverse-resolve",
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
 * `mm ensv2 resolve <name|address>` — forward or reverse resolution through
 * the ENSv2 Universal Resolver. Reverse answers have already passed the
 * on-chain ENSIP-19 forward round-trip. Runs the fail-closed gate first.
 */
export default class EnsV2Resolve extends PluginCommand<ResolveResult> {
  static override description =
    "Resolve an ENSv2 name to its address, or an address to its primary name. Refuses if the chain is not serving ENSv2.";

  static override examples = [
    "<%= config.bin %> ensv2 resolve name.eth",
    "<%= config.bin %> ensv2 resolve 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "<%= config.bin %> ensv2 resolve name.eth --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:resolve";

  async execute(io: CommandIO): Promise<ResolveResult> {
    const { query, chain } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const client = this.ctx.publicClient(chainId);

    let result: ResolveResult;
    try {
      const { deployment } = await requireEnsV2(client, chainId);
      result = await resolveQuery(client, deployment, chainId, query);
    } catch (error) {
      throw toCommandError(error);
    }

    if (result.kind === "name" && result.address === null) {
      throw new CommandError(
        "ENSV2_NAME_NOT_FOUND",
        `'${result.name}' does not resolve to an address.`,
        result.resolver === null
          ? "The name has no resolver. Check `ensv2 whois` for its registration state."
          : `The resolver at ${result.resolver} has no address record for this name.`,
      );
    }
    if (result.kind === "address" && result.name === null) {
      throw new CommandError(
        "ENSV2_NO_PRIMARY_NAME",
        `No primary ENSv2 name is set for ${result.address}.`,
        "Reverse resolution only works when the address owner has set a primary name that forward-resolves back to it. Set one with `ensv2 primary set <name>`.",
      );
    }
    return result;
  }

  override successHint(data: ResolveResult): string {
    if (data.kind === "address") return `${data.address} → ${data.name}`;
    const via = data.offset === 0 ? "own resolver" : data.offset != null ? "inherited resolver" : "";
    return `${data.name} → ${data.address}${via ? ` (${via})` : ""}`;
  }
}
