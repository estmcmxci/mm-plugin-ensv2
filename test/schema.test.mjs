// The vendored schemas are byte-identical to the program's frozen 1.0.0 set,
// and the plugin's validator gives the same answer as the program's ajv runner
// on all 75 conformance fixtures (29 must validate, 46 must be rejected).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCHEMA_DIR, SCHEMA_IDS, loadedSchemas, validateSchema } from "../dist/lib/schema.js";

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("PROVENANCE.md digests match the vendored files", () => {
  const prov = readFileSync(join(SCHEMA_DIR, "PROVENANCE.md"), "utf8");
  const rows = [...prov.matchAll(/^\| `([^`]+)` \| (?:[^|]*\| )?`([0-9a-f]{64})` \|$/gm)].map((m) => [m[1], m[2]]);
  assert.ok(rows.length >= 7 + 75, `expected at least 82 digest rows, found ${rows.length}`);
  for (const [file, digest] of rows) {
    assert.equal(sha256(join(SCHEMA_DIR, file)), digest, `${file} drifted from its recorded digest`);
  }
  assert.match(prov, /f3a53e45c1f17938599b9dfe7984053980cb91a9/);
});

test("all seven frozen schemas load at version 1.0.0", () => {
  const ids = loadedSchemas();
  for (const id of Object.values(SCHEMA_IDS)) {
    const s = ids.get(id);
    assert.ok(s, `${id} not loaded`);
    assert.equal(s.version, "1.0.0");
    assert.ok(id.endsWith(":1.0.0"));
  }
  assert.equal(ids.size, 7);
});

const byBasename = new Map();
for (const [key, id] of Object.entries(SCHEMA_IDS)) byBasename.set(id.split(":")[3], id), void key;

function fixtures(kind) {
  const dir = join(SCHEMA_DIR, "fixtures", kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, id: byBasename.get(f.split(".")[0]), data: readJson(join(dir, f)) }));
}

const valid = fixtures("valid");
const invalid = fixtures("invalid");

test("fixture counts match the D-011 freeze basis (29 positive, 46 negative)", () => {
  assert.equal(valid.length, 29);
  assert.equal(invalid.length, 46);
});

for (const fx of valid) {
  test(`valid/${fx.file} validates`, () => {
    assert.ok(fx.id, `no schema for ${fx.file}`);
    const r = validateSchema(fx.id, fx.data);
    assert.ok(r.ok, r.errors.join("\n"));
  });
}

for (const fx of invalid) {
  test(`invalid/${fx.file} is rejected (${fx.data.$expectedError ?? "no reason recorded"})`, () => {
    assert.ok(fx.id, `no schema for ${fx.file}`);
    const data = { ...fx.data };
    delete data.$expectedError;
    const r = validateSchema(fx.id, data);
    assert.equal(r.ok, false, "expected rejection but it validated");
  });
}
