import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { parseDeploymentKey } from "../../../lib/gate.js";
import { defaultStore, summarize, type JobSummary } from "../../../lib/hostjobs.js";
import { redactJobFile } from "../../../lib/jobs.js";

const inputs = {
  jobId: { type: InputFieldType.Text, flag: "job-id", message: "Job id (see `ensv2 jobs list`)", required: true, index: 0 },
  deployment: { type: InputFieldType.Text, flag: "deployment", message: "ENSv2 deployment: beta (default, the canonical Sepolia beta) or hackathon (ENS Labs' ETHOnline deployment, a newer contract generation)", required: false, prompt: false },
} satisfies InputSchema;

type ShowResult = { path: string | null; summary: JobSummary } & ReturnType<typeof redactJobFile>;

/**
 * `mm ensv2 jobs show <jobId>` — the full job file: the program-shaped intent,
 * the provisioning-job record with every step receipt and error, and the
 * private section with the commitment SECRET REDACTED. Local only.
 */
export default class EnsV2JobsShow extends PluginCommand<ShowResult> {
  static override description = "Show a provisioning job's intent, record, receipts and errors. The commitment secret is redacted.";
  static override examples = ["<%= config.bin %> ensv2 jobs show 3f2a…", "<%= config.bin %> ensv2 jobs show 3f2a… --json"];

  // Local file reads only, but declared wallet-read like every other read command; requiresAuth matches that grant.
  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:jobs:show";

  async execute(io: CommandIO): Promise<ShowResult> {
    const { jobId, deployment: deploymentFlag } = await io.resolveInputs(inputs);
    // Addressed by id, never by deployment; the flag is accepted for uniformity
    // and validated so a typo is caught, but the job's OWN deploymentId is what
    // is reported (and the only one `jobs resume` will run it against).
    parseDeploymentKey(deploymentFlag);
    const store = defaultStore();
    const file = await store.get(jobId.trim());
    if (!file) throw new CommandError("E_JOB_NOT_FOUND", `No job ${jobId} in ${store.dir}.`, "Run `mm ensv2 jobs list --all` to see the jobs on this machine.");
    return { path: store.location(file.job.jobId), summary: summarize(file, store), ...redactJobFile(file) };
  }

  override successHint(r: ShowResult): string {
    const j = r.job;
    const steps = j.steps.map((s) => `${s.step}=${s.state}${s.receipts?.length ? `(${s.receipts.map((x) => x.receiptStatus).join(",")})` : ""}`).join(" ");
    const blocked = j.resume?.blockedBy ? `\nblocked by ${j.resume.blockedBy.code} [${j.resume.blockedBy.retryability}]: ${j.resume.blockedBy.message}\nnext: ${j.resume.blockedBy.recoveryAction.description}` : "";
    return `${j.jobId} ${j.facts.normalizedName} [${r.summary.deployment ?? j.deploymentId}] ${j.state}${j.facts.erc8004AgentId ? ` agent #${j.facts.erc8004AgentId}` : ""}\n${steps}${blocked}`;
  }
}
