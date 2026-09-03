/**
 * Minimal ABIs, human-readable form. Signatures taken from the deployed
 * Sepolia artifacts (contracts-v2-post-audit-2/contracts/deployments/sepolia),
 * NOT from that repo's `contracts/src/`, which describes a different
 * generation of the resolver and does not match the chain.
 */
import { parseAbi } from "viem";

/** UpgradableUniversalResolverProxy — the public entry point. */
export const universalResolverAbi = parseAbi([
  "function supportsInterface(bytes4 interfaceId) external view returns (bool)",
  "function findCanonicalRegistry(bytes name) external view returns (address)",
  "function findExactRegistry(bytes name) external view returns (address)",
  "function findParentRegistry(bytes name) external view returns (address)",
  "function findResolver(bytes name) external view returns ((address resolver, bytes32 node, uint256 offset))",
]);

/** PermissionedRegistry — root, .eth, and every UserRegistry share this surface. */
export const registryAbi = parseAbi([
  "function getState(uint256 anyId) external view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function getSubregistry(string label) external view returns (address)",
  "function getResolver(string label) external view returns (address)",
  "function getParent() external view returns (address parent, string label)",
]);

/** VerifiableFactory. */
export const verifiableFactoryAbi = parseAbi([
  "function proxyLogic() external view returns (address)",
  // Deployed signature. The docs describe verifyContract(proxy, expectedImplementation) -> bool;
  // the Sepolia artifact has ONE argument returning the implementation address (zero if not a factory proxy).
  "function verifyContract(address proxy) external view returns (address)",
  "function deployProxy(address implementation, uint256 salt, bytes data) external returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);

/**
 * PermissionedResolver — the DEPLOYED generation. Three-argument initializer,
 * selector 0x7058b559, confirmed by bytecode presence on
 * 0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e (2026-09-03). The two-argument
 * form in ensemble-cli, and the Grant[] form in contracts-v2-post-audit-2/src,
 * both belong to other generations and revert here.
 */
export const permissionedResolverAbi = parseAbi([
  "function initialize(address admin, uint256 roleBitmap, bytes[] setters) external",
]);
