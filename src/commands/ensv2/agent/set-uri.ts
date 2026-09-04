import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { agentInfo, findAgentIdsForName, setUriPlan } from "../../../lib/agent.js";
import { parseChainId, parseDeploymentKey, requireEnsV2, toCommandError } from "../../../lib/gate.js";
import { selectedEvmAddress } from "../../../lib/wallet.js";

const inputs = {
  name: { type: InputFieldType.Text, flag: "name", message: "Registered ENSv2 name this wallet owns (e.g. myagent.eth)", required: true, index: 0 },
  uri: { type: InputFieldType.Text, flag: "uri", message: "new agentURI — http(s):// or ipfs:// URI of the agent's ERC-8004 registration JSON", required: true, prompt: true },
  agentId: { type: InputFieldType.Text, flag: "agent-id", message: "ERC-8004 agent id (default: the agent bound to the name, found by event scan)", required: false, prompt: false },
  chain: { type: InputFieldType.Text, flag: "chain", message: "EVM chain id (default 11155111, Sepolia)", required: false, prompt: false },
  deployment: { type: InputFieldType.Text, flag: "deployment", message: "ENSv2 deployment: beta (default, the canonical Sepolia beta) or hackathon (ENS Labs' ETHOnline deployment, a newer contract generation)", required: false, prompt: false },
} satisfies InputSchema;

type SetUriResult = {
  chainId: number;
  name: string;
  agentId: string;
  owner: string;
  adapter: string;
  previousURI: string;
  agentURI: string;
  alreadySet: boolean;
  txHash: string | null;
  /** IdentityRegistry/adapter tokenURI re-read after the tx equals the requested URI. */
  verified: boolean;
};

/**
 * `mm ensv2 agent set-uri <name> --uri <uri>` — point a bound agent's
 * ERC-8004 agentURI at its registration file. One transaction through
 * Adapter8004, which forwards to the IdentityRegistry only if this wallet
 * controls the bound token. Refused for orphaned bindings. No-op if already set.
 */
export default class EnsV2AgentSetUri extends PluginCommand<SetUriResult> {
  static override description = "Set a bound ERC-8004 agent's agentURI (its registration JSON) through Adapter8004, one tx. No-op if already set.";

  static override examples = [
    "<%= config.bin %> ensv2 agent set-uri myagent.eth --uri https://agent.example/agents/10058.json",
    "<%= config.bin %> ensv2 agent set-uri myagent.eth --uri ipfs://bafy... --agent-id 10058",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:agent:set-uri";

  async execute(io: CommandIO): Promise<SetUriResult> {
    const v = await io.resolveInputs(inputs);
    const chainId = parseChainId(v.chain);
    const deploymentKey = parseDeploymentKey(v.deployment);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment: d } = await requireEnsV2(client, chainId, deploymentKey);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      let agentId: bigint;
      if (v.agentId) {
        if (!/^\d+$/.test(v.agentId)) throw new CommandError("ENSV2_INVALID_AGENT_ID", `'${v.agentId}' is not an agent id.`, "Pass a decimal integer (see `ensv2 agent info`).");
        agentId = BigInt(v.agentId);
      } else {
        const scan = await findAgentIdsForName(client, d, v.name, { all: true });
        if (scan.agentIds.length === 0) throw new CommandError("ENSV2_NO_AGENT", `No agent is bound to ${v.name} (scanned blocks ${scan.scannedFrom}–${scan.scannedTo}).`, "Mint one with `ensv2 agent register`, or pass --agent-id if it was bound earlier than the scan window.");
        if (scan.agentIds.length > 1) throw new CommandError("ENSV2_AMBIGUOUS_AGENT", `${scan.agentIds.length} agents are bound to ${v.name}: ${scan.agentIds.join(", ")}.`, "Pass --agent-id to choose one.");
        agentId = scan.agentIds[0]!;
      }

      const plan = await setUriPlan(client, d, v.name, owner, agentId, v.uri);
      const base = { chainId, name: plan.name, agentId: agentId.toString(), owner, adapter: d.adapter8004, previousURI: plan.currentURI, agentURI: plan.desiredURI };
      if (!plan.calldata) return { ...base, alreadySet: true, txHash: null, verified: true };

      const execute = await this.ctx.walletExecutor(io, "ensv2:agent:set-uri");
      const result = await execute(
        {
          kind: "transaction",
          chainId,
          transaction: { to: plan.calldata.to, data: plan.calldata.data, value: plan.calldata.value },
          intent: {
            summary: `Set agentURI of agent #${agentId} (${plan.name}) to ${plan.desiredURI}`,
            action: "call",
            details: { adapter: d.adapter8004, agentId: agentId.toString(), previous: plan.currentURI || "(empty)", new: plan.desiredURI, chain: `Sepolia (${chainId})` },
          },
        },
        { waitForReceipt: true },
      );
      if (result.kind !== "transaction" || result.failureCode) {
        throw new CommandError("ENSV2_SET_URI_FAILED", `setAgentURI failed: ${result.kind === "transaction" ? (result.failureDescription ?? result.failureCode) : "non-transaction result"}`, "Nothing changed. Fix the cause and re-run; the command is idempotent.");
      }

      const after = await agentInfo(client, d, v.name, agentId);
      const verified = after.agentURI === plan.desiredURI;
      if (!verified) {
        throw new CommandError("ENSV2_SET_URI_UNVERIFIED", `tx ${result.hash} landed but the registry still reports agentURI '${after.agentURI}'.`, "Wait a block and run `ensv2 agent info`.");
      }
      return { ...base, alreadySet: false, txHash: result.hash, verified };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: SetUriResult): string {
    return d.alreadySet
      ? `agent #${d.agentId} (${d.name}) already points at ${d.agentURI} — nothing to do`
      : `agent #${d.agentId} (${d.name}): agentURI ${d.previousURI || "(empty)"} → ${d.agentURI}, tx ${d.txHash}, verified on the registry`;
  }
}
