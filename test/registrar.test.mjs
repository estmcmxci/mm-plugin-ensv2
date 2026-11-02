/**
 * revertName must not depend on the host's copy of viem.
 *
 * The CLI bundles its own viem into its dist and builds `ctx.publicClient()`
 * with it, so an error thrown by a plugin read is an instance of the HOST's
 * BaseError, never this package's. The original implementation gated on
 * `error instanceof BaseError` and therefore never matched in production:
 * `getRegisterPrice` reverting `NameNotAvailable("enfants")` on mainnet
 * surfaced as ENSV2_RPC_ERROR, "Check the RPC endpoint and try again" — advice
 * that can only waste the reader's time, since retrying never helps.
 *
 * These cases carry no viem classes at all. That is the point: they are the
 * shapes a foreign viem actually hands us.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeErrorResult, parseAbi } from "viem";
import { ethRegistrarAbi } from "../dist/lib/abis.js";
import { revertName } from "../dist/lib/registrar.js";

const NAME_NOT_AVAILABLE = encodeErrorResult({
  abi: ethRegistrarAbi,
  errorName: "NameNotAvailable",
  args: ["enfants"],
});

test("revertName decodes raw revert data from a plain, class-less error chain", () => {
  const hostShaped = { name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError", data: NAME_NOT_AVAILABLE } };
  const r = revertName(hostShaped);
  assert.equal(r?.name, "NameNotAvailable");
  assert.deepEqual(r.args, ["enfants"]);
});

test("revertName accepts a host that already decoded the error, by shape not by class", () => {
  const preDecoded = { name: "Whatever", cause: { data: { errorName: "NameNotAvailable", args: ["enfants"] } } };
  assert.deepEqual(revertName(preDecoded), { name: "NameNotAvailable", args: ["enfants"] });
});

test("revertName finds the payload however deep the cause chain runs", () => {
  const nested = { cause: { cause: { cause: { data: { data: NAME_NOT_AVAILABLE } } } } };
  assert.equal(revertName(nested)?.name, "NameNotAvailable");
});

test("revertName survives a cycle in the cause chain", () => {
  const a = { name: "outer" };
  a.cause = { name: "inner", cause: a };
  assert.equal(revertName(a), null, "no payload to find, and it must terminate");
});

test("revertName decodes DurationTooShort with its arguments intact", () => {
  const data = encodeErrorResult({ abi: ethRegistrarAbi, errorName: "DurationTooShort", args: [1n, 2419200n] });
  const r = revertName({ cause: { data } });
  assert.equal(r?.name, "DurationTooShort");
  assert.deepEqual(r.args, [1n, 2419200n]);
});

test("revertName returns null for revert data that is not ours, rather than guessing", () => {
  const foreign = encodeErrorResult({ abi: parseAbi(["error SomeOtherProtocolError(uint256 x)"]), errorName: "SomeOtherProtocolError", args: [7n] });
  assert.equal(revertName({ cause: { data: foreign } }), null);
  assert.equal(revertName(new Error("plain")), null);
  assert.equal(revertName(undefined), null);
  assert.equal(revertName({ cause: { data: "0xdeadbeef" } }), null, "too short to be a selector + args, and matches nothing");
});
