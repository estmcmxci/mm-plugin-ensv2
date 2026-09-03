#!/usr/bin/env node
// Exercise the plugin's read logic against a public Sepolia RPC with a plain
// viem client — no wallet, no install. The `mm ensv2 *` commands run these
// exact functions against the host-provided client.
//
//   npm run check                       status (the five fail-closed checks)
//   npm run check -- whois name.eth
//   npm run check -- resolver name.eth
//   npm run check -- resolve name.eth | 0xaddress
//
// ETH_RPC_URL overrides the endpoint.
import { createPublicClient, http } from "viem";
import { SEPOLIA } from "../dist/lib/deployments.js";
import { detectEnsV2, selfCheck } from "../dist/lib/ensv2.js";
import { resolveQuery, resolverInfo, whois } from "../dist/lib/reads.js";

const rpc = process.env.ETH_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ transport: http(rpc) });
const [cmd = "status", arg] = process.argv.slice(2);

const show = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const need = (v, what) => {
  if (!v) {
    console.error(`usage: npm run check -- ${cmd} <${what}>`);
    process.exit(2);
  }
  return v;
};
const gate = async () => {
  const d = await detectEnsV2(client, SEPOLIA);
  if (!d.isV2) {
    console.error(`ENSv2 NOT ACTIVE — ${d.reason}`);
    process.exit(1);
  }
  return SEPOLIA;
};

try {
  switch (cmd) {
    case "status":
      await selfCheck(rpc);
      break;
    case "whois":
      show(await whois(client, await gate(), need(arg, "name")));
      break;
    case "resolver":
      show(await resolverInfo(client, await gate(), need(arg, "name")));
      break;
    case "resolve":
      show(await resolveQuery(client, await gate(), SEPOLIA.chainId, need(arg, "name|address")));
      break;
    default:
      console.error(`unknown check "${cmd}" — one of: status, whois, resolver, resolve`);
      process.exit(2);
  }
} catch (error) {
  const code = error?.code ? `[${error.code}] ` : "";
  console.error(`${code}${error?.message ?? error}`);
  if (error?.hint) console.error(`hint: ${error.hint}`);
  process.exit(1);
}
