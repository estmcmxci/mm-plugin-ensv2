# Schema provenance

The JSON schemas in this directory are **vendored verbatim** from the program repository
`metamask-agent-identity` (`schemas/`), frozen at **1.0.0 per artifact** by decision D-011
(2026-08-25). Under that freeze a schema evolves additively only; any removal, rename, or
narrowing is a 2.0.0 major bump that needs a `DECISIONS.md` entry naming every consumer.

This plugin is a **consumer**. It does not edit these files. If the plugin needs a field, enum
value, or shape that a schema lacks, the gap is recorded in the pull request under "Schema gaps"
and worked around or dropped; it is never added here.

| Field | Value |
|---|---|
| Source repository | `metamask-agent-identity` (program repo, local path `/Users/oakgroup/queued/ENS/metamask-agent-identity`) |
| Source commit | `f3a53e45c1f17938599b9dfe7984053980cb91a9` (`f3a53e4`) |
| Vendored on | 2026-09-03 |
| Freeze decision | D-011 (waves 1 and 2 frozen at 1.0.0) |

## Files and digests (sha256)

Every file below is byte-identical to the program repository at the commit above. The test
suite (`test/schema.test.mjs`) recomputes these digests and fails if a vendored file drifts.

| File | Version | sha256 |
|---|---:|---|
| `common-primitives.schema.json` | 1.0.0 | `a326d76464ba1e611f284555e3953180b9a4c556040f8484d94ef3c77e725cd3` |
| `errors.schema.json` | 1.0.0 | `422c733379514a4f9bd426db83b7af6735e15944f6235ab9720c6aa301da98bc` |
| `step-receipt.schema.json` | 1.0.0 | `753c2d1ecdcd851dfa0e39a5e1fc72051b48c621dca45079d3403dacef28f424` |
| `verification-result.schema.json` | 1.0.0 | `e6a07c89a45b763d8cd949d2626d10408d0b795190b18f0750fb7cf67de55d9f` |
| `provisioning-intent.schema.json` | 1.0.0 | `51bf11660851eb5763fa9668d874ca5dcc9ea02573c0424a1a80c4b096d9d05e` |
| `provisioning-job.schema.json` | 1.0.0 | `54b760d892ba158d7e85cf4a83cc856f335b8bfcfe4f0ee5efd6d76575e0353a` |
| `deployment-manifest.schema.json` | 1.0.0 | `ee88278f7edba2344dbab1f1b375902d75de3d0ed15ef7aab38306b332c014af` |

`eip712-provisioning-intent.json` (the typed-data projection, frozen with `provisioning-intent`)
is **not** vendored: v0.6 computes the EIP-712 digest from its definition (see `src/lib/intent.ts`)
but does not sign it. Signing is v1.0's concern. Its digest at the source commit was
`bd8a76ca772584e35a14ec2b0db1362e0d34f8ac8b0839a6f698e891b35c2090`.

## Fixtures

`fixtures/valid/*.json` (29) and `fixtures/invalid/*.json` (46) are the program's conformance
vectors, vendored from the same commit so the plugin's validator (`src/lib/schema.ts`) can be
proven against the same suite the program's own `validate.mjs` runs. `fixtures/README.upstream.md`
is the program's fixture README, unchanged. Addresses in fixtures are synthetic placeholders; none
is a deployment address and none may be copied into code.

| Fixture | sha256 |
|---|---|
| `fixtures/invalid/deployment-manifest.fail-closed-false.json` | `46a6b1f1f99919c79c018d707e539cdac5c1ef61dd8721bcdf495a819c3371e5` |
| `fixtures/invalid/deployment-manifest.inline-abi.json` | `35bd5eb2b61d1e49db625d1f9176544f88d6a1d19004c9c539aea78e9b3d9671` |
| `fixtures/invalid/errors.identity-retryable-without-revert-confirmed.json` | `af19b7416fd3b5b1088938f1612f54beab33b5ebc8e4f3242d8eaf5e9028088e` |
| `fixtures/invalid/errors.indeterminate-with-retry-same-step.json` | `a2b8a5d640dda839167eeb9f0d792a4b595a9a78084d56866b5768639da1880d` |
| `fixtures/invalid/errors.leaks-secret-in-details.json` | `9f3e5518ea5b8ec68d9e0b7d6b327644123c8a54eba454e8fc19a385604c893a` |
| `fixtures/invalid/errors.orphaned-marked-retryable.json` | `a89a60e246ddc435b76941b3b8876dea8216c157334c823083071ce22d237616` |
| `fixtures/invalid/errors.unknown-code.json` | `aef52b7cee1b92c2476578fca670f05d6804863c198fa87b8408260409660e59` |
| `fixtures/invalid/provisioning-intent.bad-chain-format.json` | `dc22e1d555781feaf3572e897b12bf773e6e9025ae24f7a2dfff88996758533d` |
| `fixtures/invalid/provisioning-intent.deploy-owned-without-address.json` | `db9035804a5a04339013fce8107d2877e6fb292ac7d846a6c79b66f921f336f9` |
| `fixtures/invalid/provisioning-intent.direct-with-provider.json` | `6d8a33ba1e1d7f4203b9faebd209a2cf4fec377d6148b90e1a5722566f0ad706` |
| `fixtures/invalid/provisioning-intent.erc8004-without-adapter-implementation.json` | `084e142608bed09b586ef0d4559fd39ec6c17283cf222e59e80b2accda59326e` |
| `fixtures/invalid/provisioning-intent.erc8004-zero-identity-hash.json` | `bc18eddfce8ac137a8876ccf3d020ba7402ae2b226112c2b2da433f9d00be133` |
| `fixtures/invalid/provisioning-intent.identity-none-nonzero-hash.json` | `e5f75d15e5e03dcf92d6cf27808a6b7372e6c459a687c507bedc6fd7c5627622` |
| `fixtures/invalid/provisioning-intent.number-encoded-nonce.json` | `4ccb4b9cfbd5e8c248966c583d4db36d8058d43a026ce7d1254e70f2465e390e` |
| `fixtures/invalid/provisioning-intent.resource-anchor-unsatisfiable-standard.json` | `e5c202c68845193ccfec05b17370fa0b4a9b06989aac298f8f1e033f643e0589` |
| `fixtures/invalid/provisioning-intent.x402-custody-direct.json` | `3812c72652b3d25a081cbeec7862d2247b814d5837fd8feee88233de26974d51` |
| `fixtures/invalid/provisioning-job.completed-without-result.json` | `8a3ce5fca48468fc26e25e188baca31dc9ddbe496706a349ee3dfab9ef99b400` |
| `fixtures/invalid/provisioning-job.direct-with-custodial-mode.json` | `26c772a383cfcc8563c248ec1afc74f41253551d3b323356234ffd63fca75219` |
| `fixtures/invalid/provisioning-job.direct-with-provider-block.json` | `ced5096e35f86e9f2e2c7d053b33727fb0c48066dc4db931ad81e3b329b57c74` |
| `fixtures/invalid/provisioning-job.identity-bind-without-anchor.json` | `d41b898c063e26d35d7db04fd5ac1d2a4e8489383d1774f099274e5d714240ae` |
| `fixtures/invalid/provisioning-job.identity-pending-without-anchor.json` | `e87159317342599fa5ae9db4ab789252e24084735d78901ab4b1f71f39cbad52` |
| `fixtures/invalid/provisioning-job.provider-field-in-result.json` | `3a8ee2c2847410bd1affe9cb2acb021fc7aa6afaa85c70bb2b84cb970ea7fc61` |
| `fixtures/invalid/provisioning-job.provider-origin-no-idempotency-key.json` | `7b7966b3697e0cc2dd50c3eb810a622cb6f09812568f2eeb5065a10846b8cf4a` |
| `fixtures/invalid/provisioning-job.resume-into-identity-bind.json` | `e207eeb2d15e95c4b2dbd33974052d5f7d19767eddd7ea99eab6c6550462b44e` |
| `fixtures/invalid/provisioning-job.resume-into-misspelled-identity-bind.json` | `89c4591a671ef773a6dc34866b68cb06b6fb32a1d1e6abd7e3b5fb028a8a66f2` |
| `fixtures/invalid/provisioning-job.stores-commitment-secret.json` | `eb7f3c108cfedabf0adb1c2689956e1b32750d00eac4952ec49162c0438a3cce` |
| `fixtures/invalid/provisioning-job.two-settlements.json` | `a682b38b6a38279f477b5b21367a5099d5a62d285bf47098d96fecb96e657ad9` |
| `fixtures/invalid/provisioning-job.unknown-settlement-outcome-mislabelled.json` | `a9b2d8d86c9d60dd1b6ce6edaabbc0cdffb90196e10a1c7e9994d64c4a95ba84` |
| `fixtures/invalid/provisioning-job.unknown-settlement-outcome-omitted.json` | `4034ed8d2b742415563273dd388f22e6e5e52b61d0fd3ac1cba2ee5f3a2dd31b` |
| `fixtures/invalid/provisioning-job.unknown-settlement-requires-payment.json` | `fdb2e2c4d1f4a757c3fef989a75494f87d3f7005ff018f5b5c528958bd9a277f` |
| `fixtures/invalid/provisioning-job.unknown-settlement-resume-omitted.json` | `939b233733dfa860a697927dea02f3fc2d5ac396bd573d01e5ed32fafeb0606f` |
| `fixtures/invalid/step-receipt.settlement-non-hash-idempotency-key.json` | `4d698db12948905ef5109ae46425f404f634c5b4957947a08319da84bd1403c9` |
| `fixtures/invalid/step-receipt.settlement-with-payment-authorization.json` | `45cc4a97dd219f4595479aae8d386ced9bb4adb2526fd63c0253befbcac34a6e` |
| `fixtures/invalid/step-receipt.settlement-without-intent-hash.json` | `18191300fe798b6ee0aa2c0015b443e9db7980fac0629d942718e7edbfca8136` |
| `fixtures/invalid/step-receipt.transaction-numeric-gas.json` | `e722d732e1c9ba9f3fd4ee7b40af5d43a1282c29ea6189db0a825cdd481cdfbd` |
| `fixtures/invalid/verification-result.bound-anchor-survives-reregistration.json` | `5c358e1c0006772680b0c9049a6c436ab8de2da9d004b47e831584dee0eac30a` |
| `fixtures/invalid/verification-result.bound-without-binding-evidence.json` | `87065ffef9c217ab0ed11aced5e2adbf326fe0a3f6c7cc15acd3113803bb0e77` |
| `fixtures/invalid/verification-result.custody-mode-contradicts-transfer-required.json` | `19aecbdb1cb2560e660765c058d6e3924867943d9c358c018a9db89cebc05087` |
| `fixtures/invalid/verification-result.direct-mode-claims-transfer-required.json` | `32f9f0d5d9dc76ec0372b33d2fcfaf0e64dced6cc7b6e931b1bb96a1ee962aa1` |
| `fixtures/invalid/verification-result.provider-assertions-used.json` | `bdeb0706439eae4be334b52658aebd21988a78843263c314a1e3f09789cea3b1` |
| `fixtures/invalid/verification-result.resource-anchor-without-epoch-check.json` | `cae9c629c296033f0505c3e85bca07873476aa5c0d3faabe01b29d69e5b17f3d` |
| `fixtures/invalid/verification-result.verified-custody-transfer-incomplete.json` | `3dbf8713bddf07ea352e929b9543bcc93758a42465d9a588f250af1dc729406f` |
| `fixtures/invalid/verification-result.verified-endpoints-disagree.json` | `e39c5925877b0a60c6d00261cf91472f1b1348e169d9b648c5336afaaf964866` |
| `fixtures/invalid/verification-result.verified-single-rpc.json` | `50a21059ddf4c99657eb657ef051b53ab0036755ead0ac1b5539317adf0bac25` |
| `fixtures/invalid/verification-result.verified-with-registry-drift.json` | `bfe2cf5dc8eaf59aacb808b97b9df9e184843c0c74b76a826478e3ef099466b0` |
| `fixtures/invalid/verification-result.verified-without-custody.json` | `76d6101b552825e330c05dd82933da57110a969d2d8e90ae62a474bbe1cf74e6` |
| `fixtures/valid/deployment-manifest.mainnet-disabled.json` | `ade31eb7ccc2a390d4d80f24832086905d06cb8715918b88bdc2cae845f87378` |
| `fixtures/valid/deployment-manifest.sepolia-ensv2.json` | `37750f1f100749e5e8076ac90ceb9dfc75e78a70f406d6e1886651451103bacf` |
| `fixtures/valid/errors.deployment-drift.json` | `7485e2559592558df8beb466dcc25256857d336f89da41e62d1abd750be41fd2` |
| `fixtures/valid/errors.identity-failed-after-ens.json` | `4e4ee0b1b28f3c41bd5a389a701f96724adb2216d5adf9b05f61e52b419dfeba` |
| `fixtures/valid/errors.identity-orphaned-terminal.json` | `d6378ba04873b65b160b0225bccc934ddd44b522bd0469c16fa22d3720851640` |
| `fixtures/valid/errors.settlement-unknown-indeterminate.json` | `31cf7dbbf8449e909183cbfb60542fbf38ad64ff8de1869be1f1df57b803fead` |
| `fixtures/valid/provisioning-intent.direct-ens-only.json` | `1a004efc76e1c54c8e34ce216e43a00aac12289fb814fd4b6ce15ce08695f996` |
| `fixtures/valid/provisioning-intent.direct-erc8004.json` | `5e28c9224b7cd4c7d11e19791d8f63490aac24fc6565961db7555d58d7899739` |
| `fixtures/valid/provisioning-intent.x402-custody-transfer-last-erc8004.json` | `83ed49a26a616caadfba9f4db1b92a9c31a05291d52330042441e1d2f5288f5d` |
| `fixtures/valid/provisioning-intent.x402-sponsored-ens-only.json` | `8dc074612e1de7e3324db93abd6012693a51ea2b5e3ca016ab201318632acd8d` |
| `fixtures/valid/provisioning-job.direct-completed.json` | `adaacb5191bf595d09f0d613b09596f3976544a25782b498fd6c6b2cb744dc80` |
| `fixtures/valid/provisioning-job.identity-pending-anchor-recorded.json` | `554e58ba407476abf91b44d1842a597e6b741783021892059689de7f1d9b333a` |
| `fixtures/valid/provisioning-job.provider-identity-anchor-recorded.json` | `08d015c70a0a44dedc058769dd3584cbb5f7c7d10a388f6ec4c7fcffb30876e5` |
| `fixtures/valid/provisioning-job.restart-during-commitment-maturing.json` | `692ea65ec9a20732b74f5f802358a8041f7ee9b914dd4e168c452d9345d3fc6b` |
| `fixtures/valid/provisioning-job.settlement-unknown-no-auto-repay.json` | `d0b83b7899a7921e47e9dae654f6968c8045011954b78b4548e827fb425b5896` |
| `fixtures/valid/provisioning-job.x402-ens-registered-identity-failed.json` | `bdb9c22679ccec279f4b01ae7355eb9b70cca61edbab86bec237a1a8200e4d34` |
| `fixtures/valid/step-receipt.settlement-settled.json` | `ec303d8a29433232b4a7aae1b132dd54c03ba360f343e278e1af002e6288b08e` |
| `fixtures/valid/step-receipt.settlement-unknown.json` | `30d8fa9652afe476f60fe65f68de0088aa4f0601b19e77af8e59d29a7e9d6f98` |
| `fixtures/valid/step-receipt.signature-approved.json` | `9309b963cff67a4dbf6472ed2c3f47dce23d69f97776303f94ff6f9df335a341` |
| `fixtures/valid/step-receipt.signature-pending-mfa.json` | `08b2d8c02f53960ce0d5f09714aab9da376096fa526d76c71a615bad2f203da2` |
| `fixtures/valid/step-receipt.transaction-success.json` | `9f2c2297867b688d44591ac59ec4be25b90b4dc94f4347fce0347d73778bacda` |
| `fixtures/valid/step-receipt.transaction-unknown-receipt.json` | `ed07b36cc1d20b6b5f329718716394fe40b45f9f298eb46b142032b98146117a` |
| `fixtures/valid/verification-result.custodial-verified-with-resource-anchor.json` | `89ee8c943bdba3c8e75c7d9da140aaf187e65f605031d11cea90f3203eb8bf83` |
| `fixtures/valid/verification-result.custody-transfer-completed.json` | `f51553628bb0a72306d4cbd5d3c4e0bc520757bdc0a738d845ec8c8250b11d0c` |
| `fixtures/valid/verification-result.direct-verified.json` | `de49137baf275f1841a228d9777da15d234cfb032a1114ddefd20e9d98c96514` |
| `fixtures/valid/verification-result.identity-orphaned-by-token-rotation.json` | `1745668fa6f5a5efe993cb211c3b27e3bd55ef3a2e74176258845a1fed626358` |
| `fixtures/valid/verification-result.partial-identity-incomplete.json` | `fb69110cb492a2cd455b0f5beeda26f4753f3efcbf7eb470f715c1523164ec87` |
| `fixtures/valid/verification-result.resource-anchor-survives-role-change.json` | `91950da91fe417272e1a1f3acfa7665c9b7150f8560e4517317d4905246564ab` |
| `fixtures/valid/verification-result.x402-verified-identical-shape.json` | `de49137baf275f1841a228d9777da15d234cfb032a1114ddefd20e9d98c96514` |
