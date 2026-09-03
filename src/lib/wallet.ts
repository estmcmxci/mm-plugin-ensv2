/**
 * Resolve the wallet's selected EVM address from the host's wallet-state
 * snapshot (@metamask/agent-sdk/base WalletStateSnapshot):
 *
 *   selectedWallet.ref  is  { id: string } | { address: string }
 *   byokWallets[]       carry { id, address }
 *
 * The SDK types are branded, so this takes the snapshot as `unknown` and
 * narrows at runtime — which is also the right posture for reading state the
 * host owns. Reads only; the plugin never touches keys. The address is needed
 * to predict the CREATE2 resolver location (salted by deployer == owner) and
 * to name the admin in initialize().
 */
import { getAddress, isAddress, type Address } from "viem";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function selectedEvmAddress(snapshot: unknown): Address | null {
  if (!isRecord(snapshot)) return null;
  const sel = snapshot.selectedWallet;
  if (!isRecord(sel) || !isRecord(sel.ref)) return null;

  const ns = str(sel.namespace);
  if (ns && ns !== "eip155" && ns !== "evm") return null;

  let candidate = str(sel.ref.address);
  if (!candidate) {
    const id = str(sel.ref.id);
    const wallets = Array.isArray(snapshot.byokWallets) ? snapshot.byokWallets : [];
    const match = wallets.find((w) => isRecord(w) && str(w.id) === id);
    candidate = isRecord(match) ? str(match.address) : undefined;
  }
  if (!candidate || !isAddress(candidate)) return null;
  return getAddress(candidate);
}
