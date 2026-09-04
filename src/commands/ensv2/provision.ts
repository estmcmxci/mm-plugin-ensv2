import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { readFileSync } from "node:fs";
import { isAddressEqual, parseUnits } from "viem";
import { erc20Abi } from "../../lib/abis.js";
import { viemProvisionChain } from "../../lib/chain.js";
import { parseChainId, requireEnsV2 } from "../../lib/gate.js";
import { defaultStore, engineDeps, jobErrorToCommandError, programErrorToCommandError, summarize, type JobSummary } from "../../lib/hostjobs.js";
import type { JobRecord } from "../../lib/jobs.js";
import { ethLabel } from "../../lib/names.js";
import { clearPending, getPending } from "../../lib/pending.js";
import { adoptLegacyCommitment, observeJob, planProvision, runJob, stepsFor, type ProvisionRequest, type StepObservation } from "../../lib/provision.js";
import { defaultContext, endpointKey, parseEndpoints, validateEndpoints, validateProfile } from "../../lib/records.js";
import { yearsToSeconds } from "../../lib/registrar.js";
import { selectedEvmAddress } from "../../lib/wallet.js";

const t = (flag: string, message: string, extra: Record<string, unknown> = {}) => ({ type: InputFieldType.Text, flag, message, required: false, prompt: false, ...extra });
const b = (flag: string, message: string) => ({ type: InputFieldType.Boolean, flag, message, required: false, prompt: false, default: false });

const inputs = {
  name: { type: InputFieldType.Text, flag: "name", message: "Label or 2LD name to provision (e.g. myagent or myagent.eth)", required: true, index: 0 },
  years: t("years", "Registration length in years (default 1; minimum ≈ 0.08)"),
  agentUri: t("agent-uri", "agentURI — http(s):// or ipfs:// URI of the agent's ERC-8004 registration JSON (required unless --no-identity)"),
  description: t("description", "description text record — ≤160 chars (ENSIP-18)"),
  url: t("url", "url text record — http(s) website (ENSIP-5)"),
  endpoints: t("endpoints", "agent-endpoint records: mcp=<url>,a2a=<url>,web=<url> (ENSIP-26)"),
  context: t("context", "agent-context text (ENSIP-26); default: a generated Markdown stub"),
  contextFile: t("context-file", "path to a file whose contents become agent-context"),
  noIdentity: b("no-identity", "Skip the ERC-8004 identity (no Adapter8004 bind, no ENSIP-25 link)"),
  dryRun: b("dry-run", "Build the intent and plan, observe the chain, submit nothing, write nothing"),
  maxSpend: t("max-spend", "Spend ceiling in payment-token units (e.g. 8.5); default: the registrar's quote"),
  resubmitUnconfirmed: b("resubmit-unconfirmed", "You have confirmed a step recorded as submitted never landed and is not pending; allow it to be sent again"),
  verifyRpc: t("verify-rpc", "Second, independent RPC URL for the final verification (default: MM_ENSV2_VERIFY_RPC or publicnode)"),
  chain: t("chain", "EVM chain id (default 11155111, Sepolia)"),
} satisfies InputSchema;

export type ProvisionResult = {
  dryRun: false;
  job: JobSummary;
  resumed: boolean;
  steps: { step: string; state: string; attempts: number; transactions: string[] }[];
  resolver: string;
  agentId: string | null;
  verification: { outcome: string; passed: number; total: number } | null;
  transactionHashes: string[];
};

export type ProvisionDryRun = {
  dryRun: true;
  jobId: string;
  existingJob: boolean;
  inputsMatch: boolean | null;
  conflict: string | null;
  intentHash: string;
  intent: unknown;
  steps: string[];
  observations: StepObservation[];
  wouldSubmit: string[];
};

/**
 * `mm ensv2 provision <name> [...]` — resolver deploy → commit → approve →
 * wait → register → ERC-8004 bind → records, as ONE durable job.
 *
 * The job lives at ~/.mm-plugin-ensv2/jobs/<jobId>.json (mode 0600) and
 * follows the program's frozen provisioning-job 1.0.0 schema, with a step
 * receipt after every transaction. Re-running with the same inputs finds the
 * same job and resumes it; every step re-derives its completion state from
 * chain before anything is sent, so an interrupted run never repeats a paid
 * or irreversible step. A step whose outcome cannot be established halts and
 * says what to check; it is never resent automatically.
 */
export default class EnsV2Provision extends PluginCommand<ProvisionResult | ProvisionDryRun> {
  static override description =
    "Provision an ENSv2 agent identity as one resumable job: resolver, registration, ERC-8004 bind, records. Never repeats a paid step.";

  static override examples = [
    '<%= config.bin %> ensv2 provision myagent --agent-uri https://agent.example/agent.json --description "My agent" --endpoints web=https://agent.example',
    "<%= config.bin %> ensv2 provision myagent --no-identity --dry-run",
    "<%= config.bin %> ensv2 provision myagent --agent-uri ipfs://bafy... --years 2 --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:provision";

  async execute(io: CommandIO): Promise<ProvisionResult | ProvisionDryRun> {
    const v = await io.resolveInputs(inputs);
    const chainId = parseChainId(v.chain);
    const client = this.ctx.publicClient(chainId);
    const store = defaultStore();

    try {
      const { deployment: d } = await requireEnsV2(client, chainId);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      // ---- inputs → a deterministic request
      let label: string;
      try {
        label = ethLabel(v.name);
      } catch (e) {
        throw new CommandError("E_NAME_INVALID", e instanceof Error ? e.message : String(e), "Pass a registrable <label>.eth name of at least 3 characters.");
      }
      const name = `${label}.eth`;
      const duration = yearsToSeconds(v.years);

      if (!v.noIdentity && !v.agentUri) {
        throw new CommandError("ENSV2_AGENT_URI_REQUIRED", "An ERC-8004 identity needs --agent-uri.", "Pass --agent-uri <http(s)|ipfs URI of the agent's registration JSON>, or --no-identity to provision the name and records only.");
      }

      const profile: Record<string, string> = {};
      if (v.description) profile.description = v.description;
      if (v.url) profile.url = v.url;
      const perr = validateProfile(profile);
      if (perr.length) throw new CommandError("ENSV2_INVALID_RECORD", perr.join("; "), "Fix the value and re-run; nothing was written.");
      const endpoints = parseEndpoints(v.endpoints);
      const { errors: eerr, warnings } = validateEndpoints(endpoints);
      if (eerr.length) throw new CommandError("ENSV2_INVALID_RECORD", eerr.join("; "), "Fix the value and re-run; nothing was written.");
      for (const w of warnings) io.log("warn", w);

      let context = v.context;
      if (v.contextFile) {
        try {
          context = readFileSync(v.contextFile, "utf8");
        } catch (e) {
          throw new CommandError("ENSV2_CONTEXT_FILE", `Cannot read ${v.contextFile}: ${e instanceof Error ? e.message : String(e)}`, "Check the path.");
        }
      }
      // The intent must be fixed before anything is sent, so the default stub cannot mention the (not yet minted) agent id.
      if (context == null) context = defaultContext(name, profile.description, endpoints, undefined);

      const texts: Record<string, string> = { ...profile };
      for (const [p, u] of Object.entries(endpoints)) texts[endpointKey(p)] = u;
      texts["agent-context"] = context;

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
        identity: v.noIdentity ? null : { agentUri: v.agentUri! },
        records: { addr: owner, texts },
        resolverMode: "deploy-owned",
        ...(maxSpend !== undefined ? { maxSpend } : {}),
      };

      // ---- plan: existing job (resume / no-op / conflict) or a new one
      const chain = viemProvisionChain(client, d);
      const plan = await planProvision({ chain, deployment: d, store, log: (l, m) => io.log(l, m) }, req);

      if (v.dryRun) {
        const observations = await observeJob(chain, d, plan.file);
        return {
          dryRun: true,
          jobId: plan.file.job.jobId,
          existingJob: plan.kind === "existing",
          inputsMatch: plan.kind === "existing" ? plan.inputsMatch : null,
          conflict: plan.kind === "existing" && plan.conflict ? plan.conflict.code : null,
          intentHash: plan.file.intent.eip712.intentHash,
          intent: plan.file.intent,
          steps: stepsFor(plan.file.intent),
          observations,
          wouldSubmit: observations.filter((o) => o.wouldSubmit).map((o) => o.step),
        };
      }

      if (plan.kind === "existing" && !plan.inputsMatch) throw programErrorToCommandError(plan.conflict!, store);
      if (plan.kind === "new") {
        // A checkpoint left by `ensv2 register` in ~/.mm-plugin-ensv2/pending-registrations.json for this label is
        // adopted into the job — same secret, same commitment, nothing re-committed — and then removed. Standalone
        // `register` is untouched by this and keeps its own checkpoint file.
        const legacy = getPending(chainId, label);
        const adopted = !!legacy && isAddressEqual(legacy.owner, owner) && adoptLegacyCommitment(plan.file, legacy);
        if (adopted) io.log("info", `Adopted the pending registration checkpoint for ${name} into job ${plan.file.job.jobId}.`);
        await store.put(plan.file);
        if (adopted) clearPending(chainId, label);
        io.log("info", `Created job ${plan.file.job.jobId} at ${store.location(plan.file.job.jobId)}`);
      } else {
        io.log("info", `Resuming job ${plan.file.job.jobId} (${plan.file.job.state}) from ${store.location(plan.file.job.jobId)}`);
      }

      // ---- run
      const deps = await engineDeps({ ctx: this.ctx, io, commandId: "ensv2:provision", client, deployment: d, store, verifyRpc: v.verifyRpc });
      const file = await runJob(deps, plan.file, { resubmitUnconfirmed: v.resubmitUnconfirmed });
      return toResult(file.job, plan.kind === "existing", summarize(file, store));
    } catch (error) {
      throw jobErrorToCommandError(error, store);
    }
  }

  override successHint(r: ProvisionResult | ProvisionDryRun): string {
    if (r.dryRun) {
      return `${r.existingJob ? "Existing" : "New"} job ${r.jobId}${r.conflict ? ` — CONFLICT ${r.conflict}` : ""}: would submit ${r.wouldSubmit.length ? r.wouldSubmit.join(", ") : "nothing"}. Nothing was written or sent.`;
    }
    const v = r.verification ? `verification ${r.verification.outcome} (${r.verification.passed}/${r.verification.total} checks)` : "not verified";
    const line = `${r.job.name} ${r.job.state}${r.resumed ? " (resumed)" : ""}: ${v}${r.agentId ? `, agent #${r.agentId}` : ""}, ${r.transactionHashes.length} tx — job ${r.job.jobId}`;
    // The reverse record is the one thing a job does not write (see README); the follow-up is a separate, verified command.
    return r.job.state === "completed" ? `${line}. Next: mm ensv2 primary set ${r.job.name}` : line;
  }
}

export function toResult(job: JobRecord, resumed: boolean, summary: JobSummary): ProvisionResult {
  const verification = job.result?.verification;
  return {
    dryRun: false,
    job: summary,
    resumed,
    steps: job.steps.map((s) => ({ step: s.step, state: s.state, attempts: s.attempts ?? 0, transactions: (s.receipts ?? []).filter((r) => r.receiptStatus === "success").map((r) => r.transactionHash) })),
    resolver: job.facts.resolverAddress ?? "",
    agentId: job.facts.erc8004AgentId ?? null,
    verification: verification ? { outcome: verification.outcome, passed: verification.checks.filter((c) => c.passed).length, total: verification.checks.length } : null,
    transactionHashes: job.result?.transactionHashes ?? [],
  };
}
