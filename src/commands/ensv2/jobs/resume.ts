import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { isAddressEqual, parseUnits } from "viem";
import { erc20Abi } from "../../../lib/abis.js";
import { parseChainId, requireEnsV2 } from "../../../lib/gate.js";
import { defaultStore, engineDeps, jobErrorToCommandError, summarize } from "../../../lib/hostjobs.js";
import { runJob } from "../../../lib/provision.js";
import { selectedEvmAddress } from "../../../lib/wallet.js";
import { toResult, type ProvisionResult } from "../provision.js";

const b = (flag: string, message: string) => ({ type: InputFieldType.Boolean, flag, message, required: false, prompt: false, default: false });

const inputs = {
  jobId: { type: InputFieldType.Text, flag: "job-id", message: "Job id (see `ensv2 jobs list`)", required: true, index: 0 },
  resubmitUnconfirmed: b("resubmit-unconfirmed", "You have confirmed a step recorded as submitted never landed and is not pending; allow it to be sent again"),
  maxSpend: { type: InputFieldType.Text, flag: "max-spend", message: "Raise the job's spend ceiling to this amount in payment-token units (e.g. 8.5); lowering is ignored", required: false, prompt: false },
  verifyRpc: { type: InputFieldType.Text, flag: "verify-rpc", message: "Second, independent RPC URL for the final verification", required: false, prompt: false },
  chain: { type: InputFieldType.Text, flag: "chain", message: "EVM chain id (default 11155111, Sepolia)", required: false, prompt: false },
} satisfies InputSchema;

/**
 * `mm ensv2 jobs resume <jobId>` — continue a job by id. Equivalent to
 * re-running `provision` with the original arguments: every step re-derives
 * its completion from chain first; nothing paid or irreversible is resent
 * unless the chain shows it undone — and a step recorded as submitted with no
 * chain evidence stays halted until you pass --resubmit-unconfirmed.
 */
export default class EnsV2JobsResume extends PluginCommand<ProvisionResult> {
  static override description = "Resume a provisioning job by id. Re-derives every step from chain; never repeats a paid step blindly.";
  static override examples = ["<%= config.bin %> ensv2 jobs resume 3f2a…", "<%= config.bin %> ensv2 jobs resume 3f2a… --resubmit-unconfirmed"];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:jobs:resume";

  async execute(io: CommandIO): Promise<ProvisionResult> {
    const v = await io.resolveInputs(inputs);
    const store = defaultStore();
    try {
      const file = await store.get(v.jobId.trim());
      if (!file) throw new CommandError("E_JOB_NOT_FOUND", `No job ${v.jobId} in ${store.dir}.`, "Run `mm ensv2 jobs list --all`.");
      const chainId = parseChainId(v.chain);
      if (file.job.chain !== `eip155:${chainId}`) throw new CommandError("E_UNSUPPORTED_NETWORK", `Job ${file.job.jobId} is for ${file.job.chain}, not eip155:${chainId}.`, "Omit --chain or pass the job's chain.");
      const client = this.ctx.publicClient(chainId);
      const { deployment: d } = await requireEnsV2(client, chainId);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");
      if (!isAddressEqual(owner, file.job.facts.owner)) {
        throw new CommandError("ENSV2_WRONG_WALLET", `Job ${file.job.jobId} belongs to ${file.job.facts.owner}; the selected wallet is ${owner}.`, "Select the wallet that started the job (`mm wallet`), then retry.");
      }
      let raiseCeilingTo: bigint | undefined;
      if (v.maxSpend) {
        const decimals = await client.readContract({ address: d.paymentToken, abi: erc20Abi, functionName: "decimals" });
        try {
          raiseCeilingTo = parseUnits(v.maxSpend, decimals);
        } catch {
          throw new CommandError("ENSV2_INVALID_AMOUNT", `'${v.maxSpend}' is not a valid amount.`, "Example: --max-spend 8.5");
        }
      }
      const deps = await engineDeps({ ctx: this.ctx, io, commandId: "ensv2:jobs:resume", client, deployment: d, store, verifyRpc: v.verifyRpc });
      const done = await runJob(deps, file, { resubmitUnconfirmed: v.resubmitUnconfirmed, ...(raiseCeilingTo !== undefined ? { raiseCeilingTo } : {}) });
      return toResult(done.job, true, summarize(done, store));
    } catch (error) {
      throw jobErrorToCommandError(error, store);
    }
  }

  override successHint(r: ProvisionResult): string {
    const v = r.verification ? `verification ${r.verification.outcome} (${r.verification.passed}/${r.verification.total} checks)` : "not verified";
    return `${r.job.name} ${r.job.state}: ${v}${r.agentId ? `, agent #${r.agentId}` : ""}, ${r.transactionHashes.length} tx — job ${r.job.jobId}`;
  }
}
