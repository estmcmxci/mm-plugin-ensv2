import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { type Hex } from "viem";
import { agentIdFromReceipt, agentInfo, bindPlan } from "../../../lib/agent.js";
import { parseChainId, requireEnsV2, toCommandError } from "../../../lib/gate.js";
import { selectedEvmAddress } from "../../../lib/wallet.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Registered ENSv2 name this wallet owns (e.g. myagent.eth)",
    required: true,
    index: 0,
  },
  uri: {
    type: InputFieldType.Text,
    flag: "uri",
    message: "agentURI — http(s):// or ipfs:// URI of the agent's ERC-8004 registration JSON",
    required: true,
    prompt: true,
  },
  chain: {
    type: InputFieldType.Text,
    flag: "chain",
    message: "EVM chain id (default 11155111, Sepolia)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

type AgentRegisterResult = {
  chainId: number;
  name: string;
  owner: string;
  agentId: string;
  agentURI: string;
  adapter: string;
  identityRegistry: string;
  bound: { tokenContract: string; tokenId: string; standard: number };
  txHash: string;
  txStatus: string;
  verified: { bindingMatches: boolean; ownerIsController: boolean; nftHeldByAdapter: boolean };
};

/**
 * `mm ensv2 agent register <name> --uri <agentURI>` — mint an ERC-8004
 * agent through Adapter8004, bound to this wallet's ENSv2 name.
 *
 * One transaction. The adapter mints on the canonical IdentityRegistry and
 * records the binding (registry, current tokenId). Afterwards the agent id is
 * read from the AgentBound event in the receipt, and the binding, the
 * controller check, and the NFT holder are all re-read from chain before
 * success is reported.
 *
 * v0 limitation (D-012): the binding anchors on the name's current token id,
 * which changes on any role grant or revoke. `agent info` detects that.
 */
export default class EnsV2AgentRegister extends PluginCommand<AgentRegisterResult> {
  static override description =
    "Mint an ERC-8004 agent via Adapter8004, bound to your ENSv2 name. One tx, signed through MetaMask policy.";

  static override examples = [
    "<%= config.bin %> ensv2 agent register myagent.eth --uri https://example.com/agent.json",
    "<%= config.bin %> ensv2 agent register myagent.eth --uri ipfs://bafy... --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:agent:register";

  async execute(io: CommandIO): Promise<AgentRegisterResult> {
    const { name, uri, chain } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const client = this.ctx.publicClient(chainId);

    try {
      const { deployment: d } = await requireEnsV2(client, chainId);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      const plan = await bindPlan(client, d, name, owner, uri);

      const execute = await this.ctx.walletExecutor(io, "ensv2:agent:register");
      const result = await execute(
        {
          kind: "transaction",
          chainId,
          transaction: { to: plan.calldata.to, data: plan.calldata.data, value: plan.calldata.value },
          intent: {
            summary: `Mint an ERC-8004 agent bound to ${plan.name}`,
            action: "call",
            details: { adapter: plan.calldata.to, name: plan.name, tokenId: `0x${plan.tokenId.toString(16)}`, agentURI: plan.agentURI },
          },
        },
        { waitForReceipt: true },
      );
      if (result.kind !== "transaction") throw new CommandError("ENSV2_AGENT_REGISTER_FAILED", "Wallet returned a non-transaction result.", "Report this.");
      if (result.failureCode) {
        throw new CommandError(
          "ENSV2_AGENT_REGISTER_FAILED",
          `Adapter register failed: ${result.failureDescription ?? result.failureCode}${result.hash ? ` (tx ${result.hash})` : ""}`,
          "Nothing was minted. Common cause: the wallet does not own the name's current token.",
        );
      }

      // Agent id from the receipt, then everything re-read from chain.
      const receipt = await client.getTransactionReceipt({ hash: result.hash as Hex });
      const agentId = agentIdFromReceipt(receipt, d.adapter8004);
      if (agentId === null) {
        throw new CommandError("ENSV2_AGENT_REGISTER_PENDING", `Transaction ${result.hash} reported "${result.status}" but no AgentBound event is visible yet.`, "If awaiting approval, complete it and run `ensv2 agent info` once it lands.");
      }
      const info = await agentInfo(client, d, plan.name, agentId);
      const bindingMatches = info.registryMatches && !info.orphaned;
      if (!bindingMatches || !info.nftHeldByAdapter) {
        throw new CommandError(
          "ENSV2_AGENT_UNVERIFIED",
          `Agent ${agentId} was minted (tx ${result.hash}) but the on-chain binding does not match ${plan.name}: ${JSON.stringify(info.binding)}.`,
          "Report this with the transaction hash.",
        );
      }

      return {
        chainId,
        name: plan.name,
        owner,
        agentId: agentId.toString(),
        agentURI: info.agentURI,
        adapter: d.adapter8004,
        identityRegistry: d.identityRegistry,
        bound: { tokenContract: info.binding.tokenContract, tokenId: info.binding.tokenId, standard: info.binding.standard },
        txHash: result.hash,
        txStatus: result.status,
        verified: { bindingMatches, ownerIsController: info.ownerIsController, nftHeldByAdapter: info.nftHeldByAdapter },
      };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: AgentRegisterResult): string {
    return `Agent #${d.agentId} minted and bound to ${d.name} (controller: ${d.verified.ownerIsController ? "you" : "NOT you"}), tx ${d.txHash}`;
  }
}
