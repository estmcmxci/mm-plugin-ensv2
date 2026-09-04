import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { deploymentByKey } from "../../../lib/deployments.js";
import { deploymentSelection } from "../../../lib/gate.js";
import { defaultStore, summarize, type JobSummary } from "../../../lib/hostjobs.js";
import { TERMINAL_STATES } from "../../../lib/jobs.js";

const inputs = {
  all: { type: InputFieldType.Boolean, flag: "all", message: "Include completed and terminal jobs (default: only jobs that can still run)", required: false, prompt: false, default: false },
  deployment: { type: InputFieldType.Text, flag: "deployment", message: "ENSv2 deployment: beta (default, the canonical Sepolia beta) or hackathon (ENS Labs' ETHOnline deployment, a newer contract generation)", required: false, prompt: false },
} satisfies InputSchema;

type ListResult = { dir: string; count: number; deploymentFilter: string | null; jobs: JobSummary[] };

/**
 * `mm ensv2 jobs list [--all]` — the provisioning jobs on this machine, newest
 * first. Local file reads only.
 *
 * Jobs from BOTH deployments are listed by default — hiding half the machine's
 * jobs behind an unspoken default would be worse than showing them — and each
 * row names its own deployment. Pass `--deployment` (or set
 * MM_ENSV2_DEPLOYMENT) to narrow the list to one.
 */
export default class EnsV2JobsList extends PluginCommand<ListResult> {
  static override description = "List durable provisioning jobs (~/.mm-plugin-ensv2/jobs). Local only.";
  static override examples = [
    "<%= config.bin %> ensv2 jobs list",
    "<%= config.bin %> ensv2 jobs list --all --json",
    "<%= config.bin %> ensv2 jobs list --deployment hackathon",
  ];

  // Local file reads only, but declared wallet-read like every other read command; requiresAuth matches that grant.
  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:jobs:list";

  async execute(io: CommandIO): Promise<ListResult> {
    const { all, deployment: deploymentFlag } = await io.resolveInputs(inputs);
    const store = defaultStore();
    // Validates the name even when it does not filter, so a typo is still caught.
    const sel = deploymentSelection(deploymentFlag);
    const only = sel.explicit ? (deploymentByKey(sel.key)?.deploymentId ?? null) : null;
    const files = (await store.list())
      .filter((f) => all || !TERMINAL_STATES.has(f.job.state))
      .filter((f) => only === null || f.job.deploymentId === only);
    const jobs = files.map((f) => summarize(f, store)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { dir: store.dir, count: jobs.length, deploymentFilter: only, jobs };
  }

  override successHint(r: ListResult): string {
    const scope = r.deploymentFilter ? ` for deployment ${r.deploymentFilter}` : "";
    if (!r.count) return `No jobs in ${r.dir}${scope}. Start one with \`mm ensv2 provision <name> --agent-uri <uri>\`.`;
    return r.jobs
      .map((j) => `${j.jobId}  ${j.name}  ${j.deployment ?? j.deploymentId}  ${j.state}${j.blockedBy ? ` [${j.blockedBy}]` : ""}${j.resumeFrom ? ` → ${j.resumeFrom}` : ""}  ${j.updatedAt}`)
      .join("\n");
  }
}
