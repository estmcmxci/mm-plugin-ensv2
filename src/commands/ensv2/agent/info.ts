import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { agentInfo, findAgentIdsForName, type AgentInfo } from "../../../lib/agent.js";
import { parseChainId, requireEnsV2, toCommandError } from "../../../lib/gate.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "ENSv2 name (e.g. myagent.eth)",
    required: true,
    index: 0,
  },
  agentId: {
    type: InputFieldType.Text,
    flag: "agent-id",
    message: "ERC-8004 agent id (skips the event scan)",
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

type AgentInfoResult = AgentInfo & { discoveredBy: "flag" | "event-scan"; otherAgentIds: string[] };

/**
 * `mm ensv2 agent info <name> [--agent-id n]` — what the chain says about the
 * agent(s) bound to a name: the binding, whether it is orphaned (bound token
 * id ≠ current token id — a role change regenerated it), whether the owner
 * still counts as controller, who holds the NFT, and the agentURI.
 */
export default class EnsV2AgentInfo extends PluginCommand<AgentInfoResult> {
  static override description = "Show the ERC-8004 agent bound to an ENSv2 name and whether the binding is still live.";

  static override examples = ["<%= config.bin %> ensv2 agent info myagent.eth", "<%= config.bin %> ensv2 agent info myagent.eth --agent-id 42 --json"];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:agent:info";

  async execute(io: CommandIO): Promise<AgentInfoResult> {
    const { name, agentId: agentIdRaw, chain } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment: d } = await requireEnsV2(client, chainId);

      let agentId: bigint;
      let discoveredBy: "flag" | "event-scan";
      let others: bigint[] = [];
      if (agentIdRaw) {
        if (!/^\d+$/.test(agentIdRaw)) throw new CommandError("ENSV2_INVALID_AGENT_ID", `'${agentIdRaw}' is not an agent id.`, "Pass a decimal integer.");
        agentId = BigInt(agentIdRaw);
        discoveredBy = "flag";
      } else {
        io.progress("Scanning AgentBound events…");
        const scan = await findAgentIdsForName(client, d, name, { all: true });
        if (scan.agentIds.length === 0) {
          throw new CommandError(
            "ENSV2_AGENT_NOT_FOUND",
            `No AgentBound event for ${name} in blocks ${scan.scannedFrom}–${scan.scannedTo}.`,
            "Bind one with `ensv2 agent register`, or pass --agent-id if it was bound earlier than the scan window.",
          );
        }
        agentId = scan.agentIds[0]!;
        others = scan.agentIds.slice(1);
        discoveredBy = "event-scan";
      }

      const info = await agentInfo(client, d, name, agentId);
      return { ...info, discoveredBy, otherAgentIds: others.map(String) };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: AgentInfoResult): string {
    switch (d.status) {
      case "bound":
        return `${d.name} → agent #${d.agentId}, bound live (controller: ${d.ownerIsController ? "owner" : "NOT owner"})`;
      case "orphaned":
        return `${d.name} → agent #${d.agentId} is ORPHANED: bound to token ${d.binding.tokenId}, name is now ${d.currentTokenId} (a role change regenerated it)`;
      case "unbound":
        return `agent #${d.agentId} has no binding on the adapter`;
    }
  }
}
