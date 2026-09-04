import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, requireEnsV2, toCommandError } from "../../lib/gate.js";
import { quoteRegistration, yearsToSeconds, type Quote } from "../../lib/registrar.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Label or 2LD name to price (e.g. myagent or myagent.eth)",
    required: true,
    index: 0,
  },
  years: {
    type: InputFieldType.Text,
    flag: "years",
    message: "Registration length in years (default 1; decimals allowed, minimum ≈ 0.08)",
    required: false,
    prompt: false,
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
 * `mm ensv2 price <name> [--years n]` — what registering this label costs,
 * in the registrar's ERC-20 payment token (MockUSDC on the Sepolia beta).
 * Quoted by the registrar itself so premium decay and availability are
 * accounted for.
 */
export default class EnsV2Price extends PluginCommand<Quote> {
  static override description = "Quote the ERC-20 cost of registering a .eth label on ENSv2. Refuses if the chain is not serving ENSv2.";

  static override examples = [
    "<%= config.bin %> ensv2 price myagent",
    "<%= config.bin %> ensv2 price myagent --years 2",
    "<%= config.bin %> ensv2 price myagent.eth --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:price";

  async execute(io: CommandIO): Promise<Quote> {
    const { name, years, chain } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment } = await requireEnsV2(client, chainId);
      return await quoteRegistration(client, deployment, name, yearsToSeconds(years));
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(q: Quote): string {
    const prem = q.premium !== "0" ? ` (base ${q.formatted.base} + premium ${q.formatted.premium})` : "";
    return `${q.name} for ${q.durationYears} year${q.durationYears === 1 ? "" : "s"}: ${q.formatted.total} ${q.paymentToken.symbol}${prem}, paid in ERC-20 at register time`;
  }
}
