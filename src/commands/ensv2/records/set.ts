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
import { getAddress, type Address } from "viem";
import { ensip25Key } from "../../../lib/erc7930.js";
import { parseChainId, requireEnsV2, toCommandError } from "../../../lib/gate.js";
import {
  defaultContext,
  endpointKey,
  isAddressLike,
  parseEndpoints,
  planRecords,
  readRecordSet,
  validateEndpoints,
  validateProfile,
  type DesiredRecords,
} from "../../../lib/records.js";
import { selectedEvmAddress } from "../../../lib/wallet.js";

const t = (flag: string, message: string, extra: Record<string, unknown> = {}) => ({ type: InputFieldType.Text, flag, message, required: false, prompt: false, ...extra });

const inputs = {
  name: { type: InputFieldType.Text, flag: "name", message: "Your registered ENSv2 name (e.g. myagent.eth)", required: true, index: 0 },
  addr: t("addr", "ETH address the name resolves to (default: this wallet; 'none' to skip)"),
  description: t("description", "description — ≤160 chars (ENSIP-18)"),
  url: t("url", "url — http(s) website (ENSIP-5)"),
  avatar: t("avatar", "avatar — https/ipfs/data URI or eip155:<chain>/erc721|erc1155:<addr>/<id> (ENSIP-12)"),
  alias: t("alias", "alias — display name (ENSIP-18)"),
  context: t("context", "agent-context text (ENSIP-26); default: a generated Markdown stub"),
  contextFile: t("context-file", "path to a file whose contents become agent-context"),
  endpoints: t("endpoints", "agent-endpoint records: mcp=<url>,a2a=<url>,web=<url> (ENSIP-26)"),
  linkAgent: t("link-agent", "ERC-8004 agent id to link via ENSIP-25 (writes agent-registration[<registry>][<id>] = \"1\")"),
  chain: t("chain", "EVM chain id (default 11155111, Sepolia)"),
} satisfies InputSchema;

type RecordsSetResult = {
  chainId: number;
  name: string;
  resolver: string;
  written: Record<string, { from: string | null; to: string }>;
  unchanged: string[];
  warnings: string[];
  txHash: string | null;
  verified: boolean;
};

/**
 * `mm ensv2 records set <name> [...]` — write the agent's record set to the
 * wallet's own resolver in ONE transaction (resolver multicall), validating
 * every value against its ENSIP first and writing only what differs.
 */
export default class EnsV2RecordsSet extends PluginCommand<RecordsSetResult> {
  static override description =
    "Set addr, profile (ENSIP-5/12/18), agent-context + agent-endpoint (ENSIP-26) and the ENSIP-25 agent link, in one transaction.";

  static override examples = [
    '<%= config.bin %> ensv2 records set myagent.eth --description "My agent" --endpoints web=https://agent.example --link-agent 10058',
    "<%= config.bin %> ensv2 records set myagent.eth --context-file ./agent-context.md --endpoints mcp=https://agent.example/mcp",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:records:set";

  async execute(io: CommandIO): Promise<RecordsSetResult> {
    const v = await io.resolveInputs(inputs);
    const chainId = parseChainId(v.chain);
    const client = this.ctx.publicClient(chainId);

    try {
      const { deployment: d } = await requireEnsV2(client, chainId);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      // ---- assemble + validate the desired set
      const warnings: string[] = [];
      const desired: DesiredRecords = { texts: {} };

      if (v.addr !== "none") {
        if (v.addr && !isAddressLike(v.addr)) throw new CommandError("ENSV2_INVALID_ADDR", `'${v.addr}' is not an address.`, "Pass a 0x address, or 'none'.");
        desired.addr = getAddress((v.addr as Address | undefined) ?? owner);
      }

      const profile: Record<string, string> = {};
      for (const k of ["description", "url", "avatar", "alias"] as const) if (v[k]) profile[k] = v[k]!;
      const perr = validateProfile(profile);
      if (perr.length) throw new CommandError("ENSV2_INVALID_RECORD", perr.join("; "), "Fix the value and re-run; nothing was written.");
      Object.assign(desired.texts, profile);

      const endpoints = parseEndpoints(v.endpoints);
      const { errors: eerr, warnings: ewarn } = validateEndpoints(endpoints);
      if (eerr.length) throw new CommandError("ENSV2_INVALID_RECORD", eerr.join("; "), "Fix the value and re-run; nothing was written.");
      warnings.push(...ewarn);
      for (const [p, u] of Object.entries(endpoints)) desired.texts[endpointKey(p)] = u;

      if (v.linkAgent) {
        if (!/^\d+$/.test(v.linkAgent)) throw new CommandError("ENSV2_INVALID_AGENT_ID", `'${v.linkAgent}' is not an agent id.`, "Pass a decimal integer (see `ensv2 agent info`).");
        desired.texts[ensip25Key(chainId, d.identityRegistry, v.linkAgent)] = "1";
      }

      let context = v.context;
      if (v.contextFile) {
        try {
          context = readFileSync(v.contextFile, "utf8");
        } catch (e) {
          throw new CommandError("ENSV2_CONTEXT_FILE", `Cannot read ${v.contextFile}: ${e instanceof Error ? e.message : String(e)}`, "Check the path.");
        }
      }
      if (context == null) {
        const existing = await readRecordSet(client, d, v.name);
        if (existing.agent["agent-context"]?.status !== "present") {
          context = defaultContext(existing.name, profile.description, endpoints, v.linkAgent);
          warnings.push("no agent-context given and none on chain; writing a generated Markdown stub — overwrite with --context or --context-file");
        }
      }
      if (context != null) desired.texts["agent-context"] = context;

      if (!desired.addr && Object.keys(desired.texts).length === 0) {
        throw new CommandError("ENSV2_NOTHING_TO_SET", "No records specified.", "Pass at least one of --addr/--description/--url/--avatar/--alias/--context/--endpoints/--link-agent.");
      }

      // ---- diff against chain, build one multicall
      const plan = await planRecords(client, d, v.name, owner, desired);
      if (!plan.calldata) {
        return { chainId, name: plan.name, resolver: plan.resolver, written: {}, unchanged: plan.unchanged, warnings, txHash: null, verified: true };
      }

      const keys = Object.keys(plan.changes);
      const execute = await this.ctx.walletExecutor(io, "ensv2:records:set");
      const result = await execute(
        {
          kind: "transaction",
          chainId,
          transaction: { to: plan.calldata.to, data: plan.calldata.data, value: plan.calldata.value },
          intent: {
            summary: `Set ${keys.length} record${keys.length === 1 ? "" : "s"} on ${plan.name}: ${keys.join(", ")}`,
            action: "call",
            details: Object.fromEntries(keys.map((k) => [k, plan.changes[k]!.to.length > 60 ? plan.changes[k]!.to.slice(0, 57) + "…" : plan.changes[k]!.to])),
          },
        },
        { waitForReceipt: true },
      );
      if (result.kind !== "transaction" || result.failureCode) {
        throw new CommandError("ENSV2_RECORDS_FAILED", `Record write failed: ${result.kind === "transaction" ? (result.failureDescription ?? result.failureCode) : "non-transaction result"}`, "Nothing was written; the multicall is atomic. Re-run after fixing the cause.");
      }

      // ---- verify through the UR
      const after = await planRecords(client, d, v.name, owner, desired);
      const verified = after.calldata === null;
      if (!verified) {
        throw new CommandError("ENSV2_RECORDS_UNVERIFIED", `tx ${result.hash} landed but ${Object.keys(after.changes).join(", ")} still differ when read through the Universal Resolver.`, "Wait a block and run `ensv2 records get`.");
      }
      return { chainId, name: plan.name, resolver: plan.resolver, written: plan.changes, unchanged: plan.unchanged, warnings, txHash: result.hash, verified };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: RecordsSetResult): string {
    const n = Object.keys(d.written).length;
    return n === 0
      ? `${d.name}: all ${d.unchanged.length} records already up to date — nothing to do`
      : `${d.name}: wrote ${n} record${n === 1 ? "" : "s"} (${Object.keys(d.written).join(", ")}) in one tx ${d.txHash}, verified via the Universal Resolver`;
  }
}
