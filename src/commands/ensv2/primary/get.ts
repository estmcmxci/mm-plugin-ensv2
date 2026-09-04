import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { isAddress } from "viem";
import { parseChainId, requireEnsV2, toCommandError } from "../../../lib/gate.js";
import { primaryStatus, type PrimaryStatus } from "../../../lib/primary.js";
import { selectedEvmAddress } from "../../../lib/wallet.js";

const inputs = {
  address: { type: InputFieldType.Text, flag: "address", message: "0x address to inspect (default: this wallet)", required: false, prompt: false, index: 0 },
  chain: { type: InputFieldType.Text, flag: "chain", message: "EVM chain id (default 11155111, Sepolia)", required: false, prompt: false },
} satisfies InputSchema;

/**
 * `mm ensv2 primary get [address]` — the address's primary name, both layers:
 * the raw v1 reverse record (what was written) and the Universal Resolver's
 * verdict (what everyone else sees, non-null only when it round-trips).
 */
export default class EnsV2PrimaryGet extends PluginCommand<PrimaryStatus> {
  static override description = "Show an address's primary ENS name: the raw reverse record, its forward check, and the Universal Resolver round-trip.";

  static override examples = ["<%= config.bin %> ensv2 primary get", "<%= config.bin %> ensv2 primary get 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --json"];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:primary:get";

  async execute(io: CommandIO): Promise<PrimaryStatus> {
    const v = await io.resolveInputs(inputs);
    const chainId = parseChainId(v.chain);
    const client = this.ctx.publicClient(chainId);
    try {
      const { deployment } = await requireEnsV2(client, chainId);
      let address = v.address;
      if (!address) {
        const own = selectedEvmAddress(this.ctx.walletStateManager.read());
        if (!own) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected and no address was given.", "Pass an address, or run `mm wallet` to select a wallet.");
        address = own;
      }
      if (!isAddress(address)) throw new CommandError("ENSV2_INVALID_ADDR", `'${address}' is not an address.`, "Pass a 0x address.");
      return await primaryStatus(client, deployment, chainId, address);
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: PrimaryStatus): string {
    if (d.functional) return `${d.address} → ${d.primaryName} (round-trip verified via the Universal Resolver)`;
    if (d.rawName) return `${d.address}: reverse record says ${d.rawName} but it resolves to ${d.forwardAddress ?? "nothing"} — not a functional primary name`;
    return `${d.address}: no primary name — set one with \`ensv2 primary set <name>\``;
  }
}
