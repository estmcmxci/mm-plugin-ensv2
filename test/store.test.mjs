// Finding 5: the file-backed store creates exclusively and saves by
// compare-and-swap, in a temporary directory — never the real ~/.mm-plugin-ensv2.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SEPOLIA } from "../dist/lib/deployments.js";
import { ConcurrentModificationError, FileJobStore, JobExistsError } from "../dist/lib/jobs.js";
import { planProvision } from "../dist/lib/provision.js";
import { MockChain } from "./mock-chain.mjs";

const OWNER = "0x00000000000000000000000000000000000000A1";
const request = () => ({ input: "filestore", owner: OWNER, durationSeconds: 31536000n, identity: null, records: { addr: OWNER, texts: {} }, resolverMode: "deploy-owned" });

async function freshFile(store) {
  const chain = new MockChain();
  chain.fund(OWNER, 100_000_000n);
  const plan = await planProvision({ chain, deployment: SEPOLIA, store }, request());
  assert.equal(plan.kind, "new");
  return plan.file;
}

test("FileJobStore: exclusive create, 0600, CAS update, lock cleanup, abandon", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-plugin-ensv2-jobs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileJobStore(dir);

  const a = await freshFile(store);
  const b = await freshFile(store); // a concurrent second run: same id, different secret
  assert.equal(a.job.jobId, b.job.jobId);
  assert.notEqual(a.private.commitment.secret, b.private.commitment.secret);

  await store.create(a);
  assert.equal(statSync(store.location(a.job.jobId)).mode & 0o777, 0o600);
  await assert.rejects(store.create(b), (e) => e instanceof JobExistsError && e.jobId === a.job.jobId);
  assert.equal((await store.get(a.job.jobId)).private.commitment.secret, a.private.commitment.secret, "the loser did not overwrite the winner's secret");

  // CAS: the revision counts saves; a stale copy is refused and the lock file is cleaned up either way.
  const x = await store.get(a.job.jobId);
  const y = await store.get(a.job.jobId);
  assert.equal(x.revision, 0);
  x.job.state = "accepted";
  await store.update(x);
  assert.equal(x.revision, 1);
  assert.equal((await store.get(a.job.jobId)).revision, 1);
  y.job.state = "accepted";
  await assert.rejects(store.update(y), (e) => e instanceof ConcurrentModificationError && e.expectedRevision === 0 && e.actualRevision === 1);
  assert.ok(!existsSync(`${store.location(a.job.jobId)}.lock`), "no lock file left behind");
  assert.equal((await store.get(a.job.jobId)).job.state, "accepted");

  // A live lock from another process refuses; a stale one (crash leftover) is broken.
  writeFileSync(`${store.location(a.job.jobId)}.lock`, "1", { mode: 0o600 });
  await assert.rejects(store.update(x), (e) => e instanceof ConcurrentModificationError);
  rmSync(`${store.location(a.job.jobId)}.lock`);
  await store.update(x);
  assert.equal(x.revision, 2);

  // Files written before `revision` existed read as revision 0.
  const legacy = JSON.parse(JSON.stringify(x));
  delete legacy.revision;
  legacy.job.jobId = "legacyjob";
  legacy.job.facts.commitmentSecretRef = "ref:mm-plugin-ensv2:job:legacyjob:commitment";
  writeFileSync(store.location("legacyjob"), JSON.stringify(legacy), { mode: 0o600 });
  const l = await store.get("legacyjob");
  assert.equal(l.revision, 0);
  await store.update(l);
  assert.equal((await store.get("legacyjob")).revision, 1);

  // Abandon renames (never deletes); get and list stop seeing it; the record stays readable on disk.
  const where = await store.abandon(a.job.jobId);
  assert.ok(where && existsSync(where));
  assert.equal(await store.get(a.job.jobId), null);
  assert.ok(!(await store.list()).some((f) => f.job.jobId === a.job.jobId));
  assert.equal(await store.abandon(a.job.jobId), null);
  assert.ok(readdirSync(dir).some((f) => f.includes(".abandoned-")));
  // The id is free again.
  await store.create(b);
  assert.equal((await store.get(a.job.jobId)).private.commitment.secret, b.private.commitment.secret);
});
