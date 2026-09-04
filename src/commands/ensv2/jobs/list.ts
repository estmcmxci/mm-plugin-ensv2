import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { defaultStore, summarize, type JobSummary } from "../../../lib/hostjobs.js";
import { TERMINAL_STATES } from "../../../lib/jobs.js";

const inputs = {
  all: { type: InputFieldType.Boolean, flag: "all", message: "Include completed and terminal jobs (default: only jobs that can still run)", required: false, prompt: false, default: false },
} satisfies InputSchema;

type ListResult = { dir: string; count: number; jobs: JobSummary[] };

/**
 * `mm ensv2 jobs list [--all]` — the provisioning jobs on this machine, newest
 * first. Local file reads only; no wallet, no chain.
 */
export default class EnsV2JobsList extends PluginCommand<ListResult> {
  static override description = "List durable provisioning jobs (~/.mm-plugin-ensv2/jobs). Local only.";
  static override examples = ["<%= config.bin %> ensv2 jobs list", "<%= config.bin %> ensv2 jobs list --all --json"];

  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:jobs:list";

  async execute(io: CommandIO): Promise<ListResult> {
    const { all } = await io.resolveInputs(inputs);
    const store = defaultStore();
    const files = (await store.list()).filter((f) => all || !TERMINAL_STATES.has(f.job.state));
    const jobs = files.map((f) => summarize(f, store)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { dir: store.dir, count: jobs.length, jobs };
  }

  override successHint(r: ListResult): string {
    if (!r.count) return `No jobs in ${r.dir}. Start one with \`mm ensv2 provision <name> --agent-uri <uri>\`.`;
    return r.jobs.map((j) => `${j.jobId}  ${j.name}  ${j.state}${j.blockedBy ? ` [${j.blockedBy}]` : ""}${j.resumeFrom ? ` → ${j.resumeFrom}` : ""}  ${j.updatedAt}`).join("\n");
  }
}
