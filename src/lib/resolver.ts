/**
 * Owned-resolver provisioning (v0.2) — pure functions, no SDK import.
 *
 * ENSv2 replaces the shared PublicResolver with one PermissionedResolver proxy
 * per account, deployed through the VerifiableFactory with a deterministic
 * CREATE2 address. Deploy once per wallet; every name that wallet owns then
 * points at it.
 *
 * Address derivation is ported verbatim from ensdomains/ens-cli@256cc45
 * (src/lib/v2.ts: defaultOwnedResolverSalt, computeOwnedResolverAddress) and
 * matches the factory's documented scheme:
 *
 *   salt      = keccak256(abi.encode(keccak256("OwnedResolver"), owner, 0))
 *   outerSalt = keccak256(abi.encode(deployer, salt))        // factory mixes in msg.sender
 *   initCode  = ERC-1167 runtime over proxyLogic ‖ outerSalt // 45 + 32 bytes
 *   address   = CREATE2(factory, outerSalt, keccak256(initCode))
 *
 * Because outerSalt includes msg.sender, the deploy transaction MUST be sent
 * from `deployer`. This plugin always uses deployer == owner == the wallet's
 * account, which is also what ens-cli's auto-discovery assumes.
 *
 * Verified 2026-09-03 against a live proxy (0x1c73b110…, polymazia.eth's
 * resolver): recomputing CREATE2 from its ProxyDeployed (sender, salt)
 * reproduces the outerSalt embedded in its bytecode byte-for-byte, and the
 * salt formula matches contracts-v2 script/setup.ts computeOwnedResolverSalt.
 * That proxy was deployed by a relayer (sender != owner) with a custom salt,
 * so OWNER-BASED PREDICTION DOES NOT LOCATE RESOLVERS OTHER PARTIES DEPLOYED.
 * Prediction is for provisioning our own; discovery of an existing resolver
 * goes through the registry's getResolver(label) (see reads.ts), never
 * through prediction.
 *
 * `proxyLogic` is READ FROM CHAIN (conformance check 3), never assumed. The
 * initializer is generation-dependent: the three-argument form (0x7058b559) on
 * g1 (`beta`), the Grant[] form (0x33cc44a0) on g2 (`hackathon`); each is
 * absent from the other's implementation bytecode.
 *
 * THE SALT SCHEME IS THE SAME ON BOTH. The hackathon VerifiableFactory has
 * never deployed a proxy — a full-range `ProxyDeployed` scan from its own
 * deployment block (Sepolia 11,626,639) to head returns zero logs — so it was
 * proved by simulation instead: on 2026-09-04, `eth_call` of
 * `deployProxy(PermissionedResolverImpl, ownedResolverSalt(owner), initData)`
 * against 0x894bc9cC… from an arbitrary owner returned exactly the address
 * `predictOwnedResolver` computes for it (0x5690c7C0… for owner
 * 0x12345678…). The factory also carries the same one-argument
 * `verifyContract(address)` (0x3d200b45) used for the attestation check.
 */
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  isAddressEqual,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { permissionedResolverAbi, permissionedResolverG2InitAbi, verifiableFactoryAbi } from "./abis.js";
import type { EnsV2Deployment } from "./deployments.js";

/** EAC packs each role into the low bit of a 4-bit nybble; a 1 in every nybble is the all-roles grant. Mirrors ens-cli ALL_ROLES. */
export const ALL_ROLES = BigInt("0x1111111111111111111111111111111111111111111111111111111111111111");

/**
 * g2 resolver roles, transcribed from
 * contracts/src/resolver/libraries/PermissionedResolverLib.sol — the named
 * constants, not a hex literal. Each is bit 0 of its own nybble; the admin
 * counterpart is the same bit shifted 128 (nybble + 32), which is what lets
 * the holder later delegate that setter with `grantSetterRoles`.
 */
export const G2_RESOLVER_ROLE = {
  SET_ADDRESS: 1n << 0n,
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  SET_ABI: 1n << 12n,
  SET_INTERFACE: 1n << 16n,
  SET_NAME: 1n << 20n,
  SET_DATA: 1n << 24n,
  LINK: 1n << 28n,
  CAN_NAME: 1n << 120n,
  UPGRADE: 1n << 124n,
} as const;

const G2_REGULAR_ROLES = Object.values(G2_RESOLVER_ROLE).reduce((a, b) => a | b, 0n);

/**
 * The grant a g2 owned resolver is initialised with: every role
 * `PermissionedResolver` actually defines, plus each one's admin.
 *
 * Deliberately NOT g1's `ALL_ROLES` literal. `ALL_ROLES` sets bit 0 in all 64
 * nybbles, including the 22 regular and 22 admin slots this resolver defines
 * no meaning for; this bitmap sets only the 20 slots the source names, so it
 * is a strict subset (asserted in the unit tests) and grants nothing the
 * contract does not define. It is otherwise equivalent for every operation
 * this plugin performs, and matches what the ENS deploy script grants a
 * self-deployed resolver's admin.
 *
 *   0x1100000000000000000000001111111111000000000000000000000011111111
 */
export const G2_RESOLVER_ROLES = G2_REGULAR_ROLES | (G2_REGULAR_ROLES << 128n);

const OWNED_RESOLVER_ID = keccak256(stringToBytes("OwnedResolver"));
const OWNED_RESOLVER_VERSION = 0n;

/** ERC-1167 minimal-proxy runtime, split around the 20-byte logic address. `604d` = 77 bytes = 45 body + 32 salt. */
const PROXY_PREFIX = "0x3d604d80600a3d3981f3363d3d373d3d3d363d73" as const;
const PROXY_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3" as const;

export function ownedResolverSalt(owner: Address, version = OWNED_RESOLVER_VERSION): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [OWNED_RESOLVER_ID, owner, version]),
    ),
  );
}

export type Prediction = { address: Address; salt: bigint; outerSalt: Hex };

export function predictOwnedResolver(opts: { factory: Address; proxyLogic: Address; deployer: Address; owner: Address; salt?: bigint }): Prediction {
  const salt = opts.salt ?? ownedResolverSalt(opts.owner);
  const outerSalt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [opts.deployer, salt]));
  const bytecode = concat([PROXY_PREFIX, opts.proxyLogic, PROXY_SUFFIX, outerSalt]);
  return { address: getContractAddress({ bytecode, from: opts.factory, opcode: "CREATE2", salt: outerSalt }), salt, outerSalt };
}

export type OwnedResolverStatus = {
  owner: Address;
  deployer: Address;
  factory: Address;
  implementation: Address;
  /** Read from the factory on chain. */
  proxyLogic: Address;
  /** Matches the configured deployment table. */
  proxyLogicMatchesConfig: boolean;
  predicted: Address;
  salt: Hex;
  outerSalt: Hex;
  deployed: boolean;
  /** VerifiableFactory.verifyContract(predicted, implementation); null when not deployed. */
  verified: boolean | null;
};

/** Where this wallet's resolver is (or will be), and whether it exists yet. Read-only. */
export async function ownedResolverStatus(client: PublicClient, d: EnsV2Deployment, owner: Address): Promise<OwnedResolverStatus> {
  const proxyLogic = await client.readContract({ address: d.resolverFactory, abi: verifiableFactoryAbi, functionName: "proxyLogic" });
  const p = predictOwnedResolver({ factory: d.resolverFactory, proxyLogic, deployer: owner, owner });
  const code = await client.getCode({ address: p.address });
  const deployed = code != null && code !== "0x";
  // verifyContract(proxy) returns the implementation the factory attests for
  // that proxy (zero if it is not a factory-deployed proxy). Provenance holds
  // when that equals the configured implementation. (Conformance check 12.)
  let verified: boolean | null = null;
  if (deployed) {
    const attested = await client.readContract({
      address: d.resolverFactory,
      abi: verifiableFactoryAbi,
      functionName: "verifyContract",
      args: [p.address],
    });
    verified = isAddressEqual(attested, d.resolverImplementation);
  }
  return {
    owner,
    deployer: owner,
    factory: d.resolverFactory,
    implementation: d.resolverImplementation,
    proxyLogic,
    proxyLogicMatchesConfig: isAddressEqual(proxyLogic, d.resolverProxyLogic),
    predicted: p.address,
    salt: `0x${p.salt.toString(16).padStart(64, "0")}`,
    outerSalt: p.outerSalt,
    deployed,
    verified,
  };
}

export type DeployPlan = {
  to: Address;
  data: Hex;
  value: bigint;
  /** The inner initialize(admin, roleBitmap, setters) calldata forwarded by the factory. */
  initData: Hex;
  admin: Address;
  roleBitmap: Hex;
  salt: Hex;
  predicted: Address;
};

/**
 * The resolver initializer this deployment's implementation actually exposes.
 * Pure; the calldata is what the factory forwards to the fresh proxy.
 *
 * g1 `initialize(address admin, uint256 roleBitmap, bytes[] setters)` — 0x7058b559
 * g2 `initialize(Grant[] grants, bytes[] calls)`                      — 0x33cc44a0
 *
 * The two selectors are mutually absent from each other's implementation
 * bytecode (checked on both, 2026-09-03 / 2026-09-04), so a plan built for the
 * wrong generation reverts rather than half-initialising a resolver.
 */
export function buildResolverInitData(d: EnsV2Deployment, admin: Address, roleBitmap: bigint, setters: Hex[]): Hex {
  if (d.generation === "g2") {
    return encodeFunctionData({
      abi: permissionedResolverG2InitAbi,
      functionName: "initialize",
      args: [[{ account: admin, roleBitmap }], setters],
    });
  }
  return encodeFunctionData({ abi: permissionedResolverAbi, functionName: "initialize", args: [admin, roleBitmap, setters] });
}

/** The default role bitmap granted to the wallet on a freshly deployed resolver, per generation. */
export function defaultResolverRoles(d: EnsV2Deployment): bigint {
  return d.generation === "g2" ? G2_RESOLVER_ROLES : ALL_ROLES;
}

/** Unsigned calldata for VerifiableFactory.deployProxy — handed to the wallet executor, never signed here. */
export function buildDeployPlan(d: EnsV2Deployment, s: OwnedResolverStatus, opts: { roleBitmap?: bigint; setters?: Hex[] } = {}): DeployPlan {
  const roleBitmap = opts.roleBitmap ?? defaultResolverRoles(d);
  const initData = buildResolverInitData(d, s.owner, roleBitmap, opts.setters ?? []);
  const data = encodeFunctionData({
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [d.resolverImplementation, BigInt(s.salt), initData],
  });
  return { to: d.resolverFactory, data, value: 0n, initData, admin: s.owner, roleBitmap: `0x${roleBitmap.toString(16)}`, salt: s.salt, predicted: s.predicted };
}
