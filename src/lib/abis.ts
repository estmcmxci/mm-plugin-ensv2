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
  "function verifyContract(address proxy, address expectedImplementation) external view returns (bool)",
]);
