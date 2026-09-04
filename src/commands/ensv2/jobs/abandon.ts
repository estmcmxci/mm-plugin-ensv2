import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { defaultStore } from "../../../lib/hostjobs.js";
import { TERMINAL_STATES } from "../../../lib/jobs.js";

const inputs = {
  jobId: { type: InputFieldType.Text, flag: "job-id", message: "Job id (see `ensv2 jobs list --all`)", required: true, index: 0 },
  force: { type: InputFieldType.Boolean, flag: "force", message: "Set aside a job that is not finished (it may hold a live commitment whose secret goes with it)", required: false, prompt: false, default: false },
} satisfies InputSchema;

type AbandonResult = { jobId: string; name: string; state: string; movedTo: string | null };

/**
 * `mm ensv2 jobs abandon <jobId>` — set a job's record aside so a fresh job
 * for the same name (and the same inputs, hence the same id) can be started.
 * The file is renamed, never deleted: its receipts, errors and the private
 * commitment tuple stay on disk for inspection. Refuses for a job that can
 * still run unless --force is given, because an in-flight job may hold a live
 * commitment that only its secret can complete.
 */
export default class EnsV2JobsAbandon extends PluginCommand<AbandonResult> {
  static override description = "Set a finished or failed job aside (renamed, not deleted) so provision can start over for the name.";
  static override examples = ["<%= config.bin %> ensv2 jobs abandon 3f2a…", "<%= config.bin %> ensv2 jobs abandon 3f2a… --force"];

  static override requiresAuth = true;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:jobs:abandon";

  async execute(io: CommandIO): Promise<AbandonResult> {
    const { jobId, force } = await io.resolveInputs(inputs);
    const store = defaultStore();
    const file = await store.get(jobId.trim());
    if (!file) throw new CommandError("E_JOB_NOT_FOUND", `No job ${jobId} in ${store.dir}.`, "Run `mm ensv2 jobs list --all` to see the jobs on this machine.");
    if (!TERMINAL_STATES.has(file.job.state) && !force) {
      throw new CommandError(
        "ENSV2_JOB_ACTIVE",
        `Job ${file.job.jobId} is ${file.job.state} and can still run; it may hold a live commitment that only its secret can complete.`,
        `Resume it with \`mm ensv2 jobs resume ${file.job.jobId}\`, or pass --force to set it aside anyway (the record and its secret stay in the renamed file).`,
      );
    }
    const movedTo = await store.abandon(file.job.jobId);
    return { jobId: file.job.jobId, name: file.job.facts.normalizedName, state: file.job.state, movedTo };
  }

  override successHint(r: AbandonResult): string {
    return `Job ${r.jobId} (${r.name}, ${r.state}) set aside${r.movedTo ? ` at ${r.movedTo}` : ""}. A new provision for ${r.name} will start a fresh job.`;
  }
}
