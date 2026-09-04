import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { isAddressEqual, parseUnits } from "viem";
import { erc20Abi } from "../../lib/abis.js";
import { viemProvisionChain } from "../../lib/chain.js";
import { parseChainId, requireEnsV2 } from "../../lib/gate.js";
import { defaultStore, engineDeps, formatSpend, jobErrorToCommandError, programErrorToCommandError } from "../../lib/hostjobs.js";
import { ethLabel } from "../../lib/names.js";
import { clearPending, getPending } from "../../lib/pending.js";
import { adoptLegacyCommitment, planProvision, runJob, type ProvisionRequest } from "../../lib/provision.js";
import { whois } from "../../lib/reads.js";
import { yearsToSeconds } from "../../lib/registrar.js";
import { selectedEvmAddress } from "../../lib/wallet.js";

const t = (flag: string, message: string) => ({ type: InputFieldType.Text, flag, message, required: false, prompt: false });

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Label or 2LD name to register (e.g. myagent or myagent.eth)",
    required: true,
    index: 0,
  },
  years: t("years", "Registration length in years (default 1; minimum ≈ 0.08)"),
  maxSpend: t("max-spend", "Spend ceiling in payment-token units (e.g. 8.5); default: the registrar's quote"),
  resubmitUnconfirmed: { type: InputFieldType.Boolean, flag: "resubmit-unconfirmed", message: "You have confirmed a step recorded as submitted never landed and is not pending; allow it to be sent again", required: false, prompt: false, default: false },
  verifyRpc: t("verify-rpc", "Second, independent RPC URL for the final verification"),
  chain: t("chain", "EVM chain id (default 11155111, Sepolia)"),
} satisfies InputSchema;

type RegisterResult = {
  chainId: number;
  jobId: string;
  name: string;
  label: string;
  owner: string;
  resolver: string;
  durationSeconds: number;
  durationYears: number;
  price: { ceiling: string; symbol: string };
  txs: { commit: string | null; approve: string | null; register: string | null };
  resumedCommitment: boolean;
  status: string;
  expiresAt: string | null;
  tokenId: string;
  registrationEpoch: number | null;
  resolverBound: boolean;
  verification: string | null;
};

/**
 * `mm ensv2 register <name> [--years n]` — register a .eth name on ENSv2:
 * commit, wait, register — paid in the registrar's ERC-20, resolver bound at
 * registration.
 *
 * Since v0.6 this runs as a durable job (identity none, no records, resolver
 * must already exist) through the same engine as `provision`, so the
 * commit/reveal tuple and secret live in the job file and every transaction
 * gets a step receipt. Re-running resumes: the commitment, the approval and
 * the registration are each re-derived from chain before anything is sent,
 * and a step whose outcome is unknown halts rather than being resent.
 *
 * A v0.3 checkpoint in ~/.mm-plugin-ensv2/pending-registrations.json for the
 * same label is adopted into the job (its secret and commitment are kept) and
 * then removed, so an in-flight legacy commitment is never wasted.
 */
export default class EnsV2Register extends PluginCommand<RegisterResult> {
  static override description =
    "Register a .eth name on ENSv2: commit, wait, register — paid in the registrar's ERC-20, resolver set at registration. Resumable.";

  static override examples = [
    "<%= config.bin %> ensv2 register myagent",
    "<%= config.bin %> ensv2 register myagent.eth --years 2",
    "<%= config.bin %> ensv2 register myagent --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:register";

  async execute(io: CommandIO): Promise<RegisterResult> {
    const v = await io.resolveInputs(inputs);
    const chainId = parseChainId(v.chain);
    const client = this.ctx.publicClient(chainId);
    const store = defaultStore();

    try {
      const { deployment: d } = await requireEnsV2(client, chainId);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      let label: string;
      try {
        label = ethLabel(v.name);
      } catch (e) {
        throw new CommandError("E_NAME_INVALID", e instanceof Error ? e.message : String(e), "Pass a registrable <label>.eth name of at least 3 characters.");
      }
      const duration = yearsToSeconds(v.years);

      let maxSpend: bigint | undefined;
      if (v.maxSpend) {
        const decimals = await client.readContract({ address: d.paymentToken, abi: erc20Abi, functionName: "decimals" });
        try {
          maxSpend = parseUnits(v.maxSpend, decimals);
        } catch {
          throw new CommandError("ENSV2_INVALID_AMOUNT", `'${v.maxSpend}' is not a valid amount.`, "Example: --max-spend 8.5");
        }
      }

      const req: ProvisionRequest = {
        input: v.name,
        owner,
        durationSeconds: duration,
        identity: null,
        records: { addr: null, texts: {} },
        resolverMode: "reuse-existing",
        ...(maxSpend !== undefined ? { maxSpend } : {}),
      };

      const chain = viemProvisionChain(client, d);
      const plan = await planProvision({ chain, deployment: d, store, log: (l, m) => io.log(l, m) }, req);
      if (plan.kind === "existing" && !plan.inputsMatch) throw programErrorToCommandError(plan.conflict!, store);

      let resumedCommitment = plan.kind === "existing";
      if (plan.kind === "new") {
        // v0.3 → v0.6 migration: an in-flight checkpoint for this label keeps its secret by moving into the job.
        const legacy = getPending(chainId, label);
        const adopted = !!legacy && isAddressEqual(legacy.owner, owner) && adoptLegacyCommitment(plan.file, legacy);
        if (adopted) {
          resumedCommitment = true;
          io.log("info", `Adopted the pending v0.3 commitment for ${label}.eth into job ${plan.file.job.jobId}.`);
        }
        await store.put(plan.file);
        if (adopted) clearPending(chainId, label);
        io.log("info", `Created job ${plan.file.job.jobId} at ${store.location(plan.file.job.jobId)}`);
      } else {
        io.log("info", `Resuming job ${plan.file.job.jobId} (${plan.file.job.state}).`);
      }

      const deps = await engineDeps({ ctx: this.ctx, io, commandId: "ensv2:register", client, deployment: d, store, verifyRpc: v.verifyRpc });
      const file = await runJob(deps, plan.file, { resubmitUnconfirmed: v.resubmitUnconfirmed });

      const job = file.job;
      const w = await whois(client, d, job.facts.normalizedName);
      const spend = await formatSpend(client, d, file.intent.maxSpend.maxTotalAmount);
      const tx = (step: string) => job.steps.find((s) => s.step === step)?.receipts?.find((r) => r.receiptStatus === "success")?.transactionHash ?? null;
      return {
        chainId,
        jobId: job.jobId,
        name: job.facts.normalizedName,
        label,
        owner,
        resolver: job.facts.resolverAddress ?? "",
        durationSeconds: Number(duration),
        durationYears: Number(duration) / 31536000,
        price: { ceiling: spend.total, symbol: spend.symbol },
        txs: { commit: tx("commitment_submit"), approve: tx("payment_token_approve"), register: tx("registration_submit") },
        resumedCommitment,
        status: w.status,
        expiresAt: w.expiresAt,
        tokenId: w.tokenId,
        registrationEpoch: w.registrationEpoch,
        resolverBound: job.result?.verification.checks.find((c) => c.id === "resolver-own")?.passed ?? false,
        verification: job.result?.verification.outcome ?? null,
      };
    } catch (error) {
      throw jobErrorToCommandError(error, store);
    }
  }

  override successHint(d: RegisterResult): string {
    return `${d.name} ${d.status} to ${d.owner}${d.expiresAt ? ` until ${d.expiresAt.slice(0, 10)}` : ""} (ceiling ${d.price.ceiling} ${d.price.symbol})` + (d.resolverBound ? `, resolver ${d.resolver} bound` : " — WARNING: resolver not bound") + (d.txs.register ? `, tx ${d.txs.register}` : ", already registered") + ` — job ${d.jobId}`;
  }
}
