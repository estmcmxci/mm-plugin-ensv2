import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { formatUnits, isAddressEqual, type Address, type Hex } from "viem";
import type { EnsV2Deployment } from "../../lib/deployments.js";
import { parsePayWith, resolveWriteTarget, requireEnsV2, toCommandError } from "../../lib/gate.js";
import { clearPending, getPending, putPending } from "../../lib/pending.js";
import { clearPendingSwap, getPendingSwap, putPendingSwap } from "../../lib/pendingswap.js";
import { resolverInfo, whois } from "../../lib/reads.js";
import {
  ZERO_ADDRESS,
  ZERO_REFERRER,
  buildApprove,
  buildCommit,
  buildRegister,
  chainTime,
  checkAvailable,
  commitmentTime,
  computeCommitment,
  fundingHint,
  makeSecret,
  quoteRegistration,
  tokenState,
  yearsToSeconds,
  type Calldata,
  type CommitmentParams,
} from "../../lib/registrar.js";
import { ownedResolverStatus } from "../../lib/resolver.js";
import { planEthSwap, swapWrittenOffAt } from "../../lib/swap.js";
import { selectedEvmAddress } from "../../lib/wallet.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Label or 2LD name to register (e.g. myagent or myagent.eth)",
    required: true,
    index: 0,
  },
  years: {
    type: InputFieldType.Text,
    flag: "years",
    message: "Registration length in years (default 1; minimum ≈ 0.08)",
    required: false,
    prompt: false,
  },
  chain: {
    type: InputFieldType.Text,
    flag: "chain",
    message: "EVM chain id (1 for Ethereum mainnet, 11155111 for Sepolia; naming the deployment is enough, it implies its chain)",
    required: false,
    prompt: false,
  },
  payWith: {
    type: InputFieldType.Text,
    flag: "pay-with",
    message:
      "Where the payment token comes from when the wallet is short: token (default — stop and say how to fund the wallet) or eth (buy the shortfall on Uniswap v3 first, held to the Chainlink ETH/USD price). Never implied: a swap spends the wallet's ETH, so it has to be asked for",
    required: false,
    prompt: false,
  },
  deployment: {
    type: InputFieldType.Text,
    flag: "deployment",
    message: "ENSv2 deployment, REQUIRED for this command: mainnet (Ethereum L1 — spends real USDC), sepolia (ENS Labs' canonical testnet), hackathon (the ETHOnline 2026 deployment), beta (dead, kept only so old jobs resolve)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

type RegisterResult = {
  chainId: number;
  name: string;
  label: string;
  owner: string;
  resolver: string;
  durationSeconds: number;
  durationYears: number;
  price: { total: string; symbol: string };
  txs: { swap: string | null; commit: string | null; approve: string | null; register: string };
  resumedCommitment: boolean;
  status: string;
  expiresAt: string | null;
  tokenId: string;
  registrationEpoch: number | null;
  resolverBound: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `mm ensv2 register <name> [--years n]` — register a .eth name on ENSv2.
 *
 * Sequence, each step verified on chain before the next:
 *   1. gate; wallet address; label available; wallet's resolver exists
 *      (its address is bound INTO the commitment, so it must exist first)
 *   2. quote from the registrar; balance must cover it — or, with
 *      `--pay-with eth`, the shortfall is bought on Uniswap v3 first, before
 *      the commit, so a refused swap leaves no commitment behind
 *   3. commit(makeCommitment(...))  — secret checkpointed to disk FIRST
 *   4. approve(registrar, total) if allowance is short — done during the wait
 *   5. wait until chain time ≥ commit + MIN_COMMITMENT_AGE (60 s), < MAX (24 h)
 *   6. register(...)               — pays, mints, sets the resolver
 *   7. verify: registry says REGISTERED to this owner; UR.findResolver is our
 *      resolver at offset 0; then clear the checkpoint
 *
 * Re-running after an interruption resumes from the checkpoint: same secret,
 * same commitment, no second commit. An expired commitment (> 24 h) is
 * re-committed with the same parameters.
 */
export default class EnsV2Register extends PluginCommand<RegisterResult> {
  static override description =
    "Register a .eth name on ENSv2: commit, wait, register — paid in the registrar's ERC-20, resolver set at registration. Resumable. With --pay-with eth, a wallet short on the token buys the shortfall with its ETH first.";

  static override examples = [
    "<%= config.bin %> ensv2 register myagent --deployment sepolia",
    "<%= config.bin %> ensv2 register myagent.eth --years 2 --deployment sepolia",
    "<%= config.bin %> ensv2 register myagent --json --deployment sepolia",
    "<%= config.bin %> ensv2 register myagent --deployment mainnet --pay-with eth",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "ensv2:register";

  async execute(io: CommandIO): Promise<RegisterResult> {
    const { name: input, years, chain, deployment: deploymentFlag, payWith: payWithFlag } = await io.resolveInputs(inputs);
    const payWith = parsePayWith(payWithFlag);
    const { chainId, deploymentKey } = resolveWriteTarget(chain, deploymentFlag);
    const client = this.ctx.publicClient(chainId);

    try {
      const { deployment: d } = await requireEnsV2(client, chainId, deploymentKey);
      const owner = selectedEvmAddress(this.ctx.walletStateManager.read());
      if (!owner) throw new CommandError("ENSV2_NO_WALLET", "No EVM wallet is selected.", "Run `mm wallet` to create or select one, then retry.");

      // 1. preconditions
      const duration = yearsToSeconds(years);
      const avail = await checkAvailable(client, d, input);
      const { label, name } = avail;
      if (!avail.available) {
        throw new CommandError("ENSV2_NAME_NOT_AVAILABLE", `${name} is not available to register.`, "Registered, in grace, or reserved from ENSv1 pre-migration. Check `ensv2 whois`.");
      }
      const res = await ownedResolverStatus(client, d, owner);
      if (!res.deployed || res.verified !== true) {
        throw new CommandError(
          "ENSV2_RESOLVER_MISSING",
          `This wallet has no verified ENSv2 resolver yet (would be ${res.predicted}).`,
          "Run `mm ensv2 resolver deploy` first — the resolver address is bound into the registration commitment.",
        );
      }
      const resolver = res.predicted;

      // 2. price + funds
      const quote = await quoteRegistration(client, d, label, duration);
      const total = BigInt(quote.total);
      let { balance, allowance } = await tokenState(client, d, owner);

      const execute = await this.ctx.walletExecutor(io, "ensv2:register");
      const send = async (cd: Calldata, summary: string, details: Record<string, string>): Promise<Hex> => {
        const r = await execute(
          { kind: "transaction", chainId, transaction: { to: cd.to, data: cd.data, value: cd.value }, intent: { summary, action: "call", details } },
          { waitForReceipt: true },
        );
        if (r.kind !== "transaction") throw new CommandError("ENSV2_TX_FAILED", `${summary}: non-transaction result.`, "Report this.");
        if (r.failureCode) throw new CommandError("ENSV2_TX_FAILED", `${summary} failed: ${r.failureDescription ?? r.failureCode}${r.hash ? ` (tx ${r.hash})` : ""}`, "Fix the cause and re-run; the command resumes from its checkpoint.");
        return r.hash as Hex;
      };

      // 2b. A wallet short on the payment token stops here with advice, or —
      //     only when asked for — buys the shortfall with the ETH it holds.
      //     Before the commit, deliberately: a refused or reverted swap then
      //     costs nothing but its gas, with no commitment left to age out.
      let swapTx: Hex | null = null;
      if (balance < total) {
        const shortfall = total - balance;
        if (payWith !== "eth") {
          throw new CommandError(
            "ENSV2_INSUFFICIENT_FUNDS",
            `Registering ${name} costs ${quote.formatted.total} ${quote.paymentToken.symbol}; this wallet holds ${formatUnits(balance, quote.paymentToken.decimals)}.`,
            `${fundingHint(d, shortfall, quote.paymentToken)} Or pass \`--pay-with eth\` to buy the ${formatUnits(shortfall, quote.paymentToken.decimals)} ${quote.paymentToken.symbol} it is short with the ETH this wallet already holds.`,
          );
        }
        // A swap already sent for this wallet may still land; buying again
        // before its deadline could pay twice. The amount to buy is always
        // re-derived from the balance above, never read back from the record.
        const saved = getPendingSwap(chainId, owner);
        const nowSec = await chainTime(client);
        if (saved && nowSec < swapWrittenOffAt(saved.deadline)) {
          throw new CommandError(
            "ENSV2_SWAP_PENDING",
            `A swap for ${saved.amountOut} ${quote.paymentToken.symbol} units was sent for this wallet at ${saved.createdAt}${saved.txHash ? ` (tx ${saved.txHash})` : ""} and the tokens are not here yet.`,
            `Do not send another. Wait for it and re-run; this command counts whatever it delivered. If it never lands, re-run after ${new Date(swapWrittenOffAt(saved.deadline) * 1000).toISOString()} — past its deadline the router refuses it, so a fresh swap is safe.`,
          );
        }
        if (saved) {
          io.log("warn", `A swap sent at ${saved.createdAt} is past its deadline; the router refuses it now, so a fresh one is safe.`);
          clearPendingSwap(chainId, owner);
        }
        const plan = await planEthSwap(client, d, {
          shortfall,
          decimals: quote.paymentToken.decimals,
          owner,
          ceiling: total,
          nowSeconds: nowSec,
        });
        // The checkpoint goes in BEFORE the wallet sees the request.
        putPendingSwap({
          chainId,
          owner,
          deploymentId: d.deploymentId,
          amountOut: plan.quote.amountOut.toString(),
          maximumEth: plan.quote.maximumEth.toString(),
          fee: plan.quote.fee,
          deadline: plan.deadline,
          txHash: null,
          createdAt: new Date().toISOString(),
        });
        swapTx = await send(plan.call, `Buy ${formatUnits(shortfall, quote.paymentToken.decimals)} ${quote.paymentToken.symbol} with ETH to pay for ${name}`, {
          router: plan.call.to,
          buying: `${formatUnits(shortfall, quote.paymentToken.decimals)} ${quote.paymentToken.symbol}`,
          maxSpend: `${plan.quote.maximumEth} wei`,
          pool: `${plan.quote.fee / 10_000}%`,
        });
        // `send` only returns on a confirmed, non-failed transaction, so the
        // swap is settled either way and the checkpoint has done its work.
        clearPendingSwap(chainId, owner);
        ({ balance, allowance } = await tokenState(client, d, owner));
        if (balance < total) {
          throw new CommandError(
            "ENSV2_SWAP_UNSETTLED",
            `Swap ${swapTx} succeeded but this wallet holds ${formatUnits(balance, quote.paymentToken.decimals)} ${quote.paymentToken.symbol}, short of the ${quote.formatted.total} quoted.`,
            "Wait a block and re-run; the shortfall is re-derived from the balance, so only what is still missing is bought.",
          );
        }
        io.log("info", `Bought ${formatUnits(shortfall, quote.paymentToken.decimals)} ${quote.paymentToken.symbol} for at most ${plan.quote.maximumEth} wei (tx ${swapTx}).`);
      }

      // 3. commitment — checkpoint before the commit tx is sent
      let params: CommitmentParams;
      let commitment: Hex;
      let resumed = false;
      const pending = getPending(chainId, label);
      if (pending && isAddressEqual(pending.owner, owner) && isAddressEqual(pending.resolver, resolver) && pending.durationSeconds === Number(duration)) {
        params = { label, owner, secret: pending.secret, subregistry: pending.subregistry, resolver, durationSeconds: duration, referrer: pending.referrer };
        commitment = pending.commitment;
        resumed = true;
        io.log("info", `Resuming pending registration of ${name} from checkpoint.`);
      } else {
        params = { label, owner, secret: makeSecret(), subregistry: ZERO_ADDRESS, resolver, durationSeconds: duration, referrer: ZERO_REFERRER };
        commitment = await computeCommitment(client, d, params);
        putPending({ chainId, label, owner, secret: params.secret, subregistry: params.subregistry, resolver, durationSeconds: Number(duration), referrer: params.referrer, commitment, commitTx: null, commitTime: null, createdAt: new Date().toISOString() });
      }

      let commitTx: Hex | null = pending?.commitTx ?? null;
      let t0 = await commitmentTime(client, d, commitment);
      let now = await chainTime(client);
      if (t0 === 0 || now >= t0 + avail.maxCommitmentAge) {
        if (t0 !== 0) io.log("warn", `Previous commitment expired (${avail.maxCommitmentAge / 3600}h); committing again with the same parameters.`);
        commitTx = await send(buildCommit(d, commitment), `Commit to register ${name}`, { name, resolver, duration: `${quote.durationYears} year(s)` });
        t0 = await commitmentTime(client, d, commitment);
        if (t0 === 0) throw new CommandError("ENSV2_COMMIT_PENDING", `Commit tx ${commitTx} is not visible on chain yet.`, "If awaiting approval, complete it and re-run; the checkpoint is saved.");
        putPending({ chainId, label, owner, secret: params.secret, subregistry: params.subregistry, resolver, durationSeconds: Number(duration), referrer: params.referrer, commitment, commitTx, commitTime: t0, createdAt: pending?.createdAt ?? new Date().toISOString() });
      }

      // 4. approval, overlapped with the commitment wait
      let approveTx: Hex | null = null;
      if (allowance < total) {
        approveTx = await send(buildApprove(d, total), `Approve ${quote.formatted.total} ${quote.paymentToken.symbol} for the ENSv2 registrar`, { spender: d.registrar, amount: `${quote.formatted.total} ${quote.paymentToken.symbol}` });
        const after = await tokenState(client, d, owner);
        if (after.allowance < total) throw new CommandError("ENSV2_APPROVE_PENDING", `Approval tx ${approveTx} is not reflected on chain yet.`, "If awaiting approval, complete it and re-run.");
      }

      // 5. wait out MIN_COMMITMENT_AGE on CHAIN time (+1 s, as the reference scripts do)
      const ready = t0 + avail.minCommitmentAge + 1;
      now = await chainTime(client);
      while (now < ready) {
        io.progress(`Commitment aging: ${ready - now}s until register is allowed`);
        await sleep(Math.min(5000, Math.max(1000, (ready - now) * 1000)));
        now = await chainTime(client);
      }
      if (now >= t0 + avail.maxCommitmentAge) {
        throw new CommandError("ENSV2_COMMITMENT_EXPIRED", "The commitment expired before register was called.", "Re-run; it will re-commit with the same parameters.");
      }

      // 6. register
      const registerTx = await send(
        buildRegister(d, params),
        `Register ${name} for ${quote.durationYears} year(s) — ${quote.formatted.total} ${quote.paymentToken.symbol}`,
        { name, owner, resolver, price: `${quote.formatted.total} ${quote.paymentToken.symbol}`, expires: `~${new Date((now + Number(duration)) * 1000).toISOString().slice(0, 10)}` },
      );

      // 7. verify on chain, then clear the checkpoint
      const w = await whois(client, d, name);
      if (w.status !== "REGISTERED" || !w.owner || !isAddressEqual(w.owner, owner)) {
        throw new CommandError("ENSV2_REGISTER_UNVERIFIED", `Register tx ${registerTx} sent, but the registry reports ${name} as ${w.status}${w.owner ? ` owned by ${w.owner}` : ""}.`, "Wait a block and check `ensv2 whois`; the checkpoint is kept.");
      }
      const r = await resolverInfo(client, d, name);
      const resolverBound = r.kind === "own" && r.resolver !== null && isAddressEqual(r.resolver, resolver);
      clearPending(chainId, label);

      return {
        chainId,
        name,
        label,
        owner,
        resolver,
        durationSeconds: Number(duration),
        durationYears: quote.durationYears,
        price: { total: quote.formatted.total, symbol: quote.paymentToken.symbol },
        txs: { swap: swapTx, commit: commitTx, approve: approveTx, register: registerTx },
        resumedCommitment: resumed,
        status: w.status,
        expiresAt: w.expiresAt,
        tokenId: w.tokenId,
        registrationEpoch: w.registrationEpoch,
        resolverBound,
      };
    } catch (error) {
      throw toCommandError(error);
    }
  }

  override successHint(d: RegisterResult): string {
    return `${d.name} registered to ${d.owner} until ${d.expiresAt?.slice(0, 10)} for ${d.price.total} ${d.price.symbol}` + (d.resolverBound ? `, resolver ${d.resolver} bound` : " — WARNING: resolver not bound") + `, tx ${d.txs.register}`;
  }
}
