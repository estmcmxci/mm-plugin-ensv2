import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { formatUnits, parseUnits } from "viem";
import { erc20Abi } from "../../lib/abis.js";
import { SEPOLIA_CHAIN_ID } from "../../lib/deployments.js";
import { parseChainId, parseDeploymentKey, requireEnsV2, toCommandError } from "../../lib/gate.js";
import { buildMint, tokenState } from "../../lib/registrar.js";
import { selectedEvmAddress } from "../../lib/wallet.js";

const inputs = {
  amount: {
    type: InputFieldType.Text,
    flag: "amount",
    message: "Amount of test USDC to mint (default 100)",
    required: false,
    prompt: false,
  },
  chain: {
    type: InputFieldType.Text,
    flag: "chain",
    message: "EVM chain id (default 11155111, Sepolia)",
    required: false,
    prompt: false,
  },
  deployment: {
    type: InputFieldType.Text,
    flag: "deployment",
    message: "ENSv2 deployment: beta (default, the canonical Sepolia beta) or hackathon (ENS Labs' ETHOnline deployment, a newer contract generation)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

type FaucetResult = {
  chainId: number;
  owner: string;
  token: { address: string; symbol: string; decimals: number };
  minted: string;
  balanceBefore: string;
  balanceAfter: string;
  txHash: string;
};

/**
 * `mm ensv2 faucet [--amount n]` — mint the Sepolia beta's MockUSDC to this
 * wallet so `register` can pay for a name. MockUSDC.mint has no access
 * control by design; this command refuses to run anywhere but Sepolia.
 */
export default class EnsV2Faucet extends PluginCommand<FaucetResult> {
  static override description = "Mint Sepolia test USDC (the ENSv2 beta payment token) to this wallet. Sepolia only.";

  static override examples = ["<%= config.bin %> ensv2 faucet", "<%= config.bin %> ensv2 faucet --amount 20"];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:faucet";

  async execute(io: CommandIO): Promise<FaucetResult> {
    const { amount, chain, deployment: deploymentFlag } = await io.resolveInputs(inputs);
    const chainId = parseChainId(chain);
    const deploymentKey = parseDeploymentKey(deploymentFlag);
    if (chainId !== SEPOLIA_CHAIN_ID) {
      throw new CommandError("ENSV2_FAUCET_SEPOLIA_ONLY", "The faucet mints a mock token that only exists on Sepolia.", "Omit --chain.");
    }
    const client = this.ctx.publicClient(chainId);

    try {
      const { deployment } = await requireEnsV2(client, chainId, deploymentKey);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      const tok = { address: deployment.paymentToken, abi: erc20Abi } as const;
      const [symbol, decimals] = await Promise.all([
        client.readContract({ ...tok, functionName: "symbol" }),
        client.readContract({ ...tok, functionName: "decimals" }),
      ]);
      const human = amount == null || amount === "" ? "100" : amount;
      let units: bigint;
      try {
        units = parseUnits(human, decimals);
      } catch {
        throw new CommandError("ENSV2_INVALID_AMOUNT", `'${human}' is not a valid ${symbol} amount.`, "Example: --amount 20");
      }
      if (units <= 0n) throw new CommandError("ENSV2_INVALID_AMOUNT", "Amount must be positive.", "Example: --amount 20");

      const { balance: before } = await tokenState(client, deployment, owner);
      const cd = buildMint(deployment, owner, units);
      const execute = await this.ctx.walletExecutor(io, "ensv2:faucet");
      const result = await execute(
        {
          kind: "transaction",
          chainId,
          transaction: { to: cd.to, data: cd.data, value: cd.value },
          intent: {
            summary: `Mint ${human} test ${symbol} to ${owner} (Sepolia MockUSDC)`,
            action: "call",
            details: { token: cd.to, amount: `${human} ${symbol}`, to: owner },
          },
        },
        { waitForReceipt: true },
      );
      if (result.kind !== "transaction" || result.failureCode) {
        throw new CommandError("ENSV2_FAUCET_FAILED", `Mint failed: ${result.kind === "transaction" ? (result.failureDescription ?? result.failureCode) : "non-transaction result"}`, "Retry; nothing was minted.");
      }

      const { balance: after } = await tokenState(client, deployment, owner);
      if (after < before + units) {
        throw new CommandError("ENSV2_FAUCET_PENDING", `Transaction ${result.hash} reported "${result.status}" but the balance has not increased yet.`, "If awaiting approval, complete it and check `mm wallet balance --testnet-chain-ids 11155111`.");
      }

      return {
        chainId,
        owner,
        token: { address: deployment.paymentToken, symbol, decimals },
        minted: human,
        balanceBefore: formatUnits(before, decimals),
        balanceAfter: formatUnits(after, decimals),
        txHash: result.hash,
      };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: FaucetResult): string {
    return `Minted ${d.minted} ${d.token.symbol} — balance ${d.balanceBefore} → ${d.balanceAfter}, tx ${d.txHash}`;
  }
}
