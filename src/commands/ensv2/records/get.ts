import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, parseDeploymentKey, requireEnsV2, toCommandError } from "../../../lib/gate.js";
import { readRecordSet, type RecordSet } from "../../../lib/records.js";

const inputs = {
  name: { type: InputFieldType.Text, flag: "name", message: "ENSv2 name (e.g. myagent.eth)", required: true, index: 0 },
  agentIds: { type: InputFieldType.Text, flag: "agent-ids", message: "comma-separated ERC-8004 agent ids to check ENSIP-25 links for", required: false, prompt: false },
  chain: { type: InputFieldType.Text, flag: "chain", message: "EVM chain id (default 11155111, Sepolia)", required: false, prompt: false },
  deployment: { type: InputFieldType.Text, flag: "deployment", message: "ENSv2 deployment: beta (default, the canonical Sepolia beta) or hackathon (ENS Labs' ETHOnline deployment, a newer contract generation)", required: false, prompt: false },
} satisfies InputSchema;

/**
 * `mm ensv2 records get <name> [--agent-ids 1,2]` — the agent's record set as
 * a stranger would see it: every read goes through the Universal Resolver,
 * each key is present / absent / lookup_failed, values are checked against
 * their ENSIP, and ENSIP-25 keys are parsed back to (chain, registry, id).
 * ENSIP-25 has no enumeration, so links are checked for the ids you pass
 * (plus any ensemble-cli `agent-ids` index, read for compatibility only).
 */
export default class EnsV2RecordsGet extends PluginCommand<RecordSet> {
  static override description = "Read a name's addr, profile, ENSIP-26 agent records, and ENSIP-25 links through the Universal Resolver.";

  static override examples = ["<%= config.bin %> ensv2 records get myagent.eth", "<%= config.bin %> ensv2 records get myagent.eth --agent-ids 10058 --json"];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:records:get";

  async execute(io: CommandIO): Promise<RecordSet> {
    const { name, agentIds, chain, deployment: deploymentFlag } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const deploymentKey = parseDeploymentKey(deploymentFlag);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment } = await requireEnsV2(client, chainId, deploymentKey);
      const ids = agentIds ? agentIds.split(",").map((s) => s.trim()).filter(Boolean) : [];
      return await readRecordSet(client, deployment, name, { agentIds: ids });
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: RecordSet): string {
    const present = (r: Record<string, { status: string }>) => Object.entries(r).filter(([, v]) => v.status === "present").map(([k]) => k);
    const failed = [...Object.values(d.profile), ...Object.values(d.agent), d.addr].filter((r) => r.status === "lookup_failed").length;
    const links = d.links.filter((l) => l.read.status === "present").map((l) => `#${l.agentId}`);
    return `${d.name}: addr ${d.addr.status === "present" ? d.addr.value : "—"}; ${[...present(d.profile), ...present(d.agent)].join(", ") || "no text records"}${links.length ? `; linked agents ${links.join(", ")}` : ""}${failed ? `; ${failed} lookups FAILED` : ""}`;
  }
}
