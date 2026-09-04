/**
 * Validator for the vendored program schemas (schemas/*.schema.json, frozen at
 * 1.0.0 by D-011; provenance in schemas/PROVENANCE.md).
 *
 * This is a small JSON Schema draft 2020-12 validator that implements exactly
 * the keywords those seven schemas use — no more. It exists so the plugin can
 * validate every job record, step receipt, error and verification result it
 * writes without adding a dependency to the runtime bundle. It is proven
 * against the program's own conformance suite: test/schema.test.mjs runs the
 * 29 positive and 46 negative fixtures vendored from the same commit and
 * requires the same pass/reject answer the program's ajv runner gives.
 *
 * Keywords: $ref (urn ids and #/$defs pointers), $defs, type, enum, const,
 * required, properties, additionalProperties, propertyNames, pattern,
 * minLength, maxLength, minimum, maximum, items, contains, minItems, maxItems,
 * uniqueItems, allOf, anyOf, oneOf, not, if/then/else, format (date-time, uri).
 * Annotation keywords ($schema, $id, title, description, $comment, version)
 * are ignored, as in ajv.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type SchemaObject = Record<string, unknown>;
type Schema = SchemaObject | boolean;

/** Package-root `schemas/` — this file compiles to dist/lib/schema.js. */
export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

export const SCHEMA_IDS = {
  primitives: "urn:mm-ens-identity:schema:common-primitives:1.0.0",
  errors: "urn:mm-ens-identity:schema:errors:1.0.0",
  stepReceipt: "urn:mm-ens-identity:schema:step-receipt:1.0.0",
  verificationResult: "urn:mm-ens-identity:schema:verification-result:1.0.0",
  intent: "urn:mm-ens-identity:schema:provisioning-intent:1.0.0",
  job: "urn:mm-ens-identity:schema:provisioning-job:1.0.0",
  manifest: "urn:mm-ens-identity:schema:deployment-manifest:1.0.0",
} as const;

let registry: Map<string, SchemaObject> | null = null;

function loadRegistry(): Map<string, SchemaObject> {
  if (registry) return registry;
  const map = new Map<string, SchemaObject>();
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort()) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as SchemaObject;
    if (typeof schema.$id !== "string") throw new Error(`${file}: schema has no $id`);
    map.set(schema.$id, schema);
  }
  registry = map;
  return map;
}

/** Every vendored schema, keyed by $id. */
export function loadedSchemas(): ReadonlyMap<string, SchemaObject> {
  return loadRegistry();
}

// ---------------------------------------------------------------------------

type Ctx = { root: SchemaObject; registry: Map<string, SchemaObject> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  if (want === "number") return t === "number" || t === "integer";
  return t === want;
}

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[a-z][a-z0-9+.-]*:[^\s]*$/i;

function formatOk(format: string, v: string): boolean {
  switch (format) {
    case "date-time":
      return DATE_TIME_RE.test(v) && !Number.isNaN(Date.parse(v));
    case "uri":
      return URI_RE.test(v);
    default:
      return true; // unknown formats are annotations, as in ajv's default mode
  }
}

function resolveRef(ref: string, ctx: Ctx): { schema: Schema; ctx: Ctx } {
  const [base, fragment = ""] = ref.split("#", 2) as [string, string?];
  let root = ctx.root;
  if (base) {
    const found = ctx.registry.get(base);
    if (!found) throw new Error(`unresolvable $ref ${ref}`);
    root = found;
  }
  let node: unknown = root;
  if (fragment) {
    if (!fragment.startsWith("/")) throw new Error(`unsupported $ref fragment ${ref}`);
    for (const raw of fragment.slice(1).split("/")) {
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObject(node) || !(key in node)) throw new Error(`unresolvable $ref ${ref}`);
      node = node[key];
    }
  }
  if (typeof node !== "boolean" && !isObject(node)) throw new Error(`$ref ${ref} does not point at a schema`);
  return { schema: node as Schema, ctx: { root, registry: ctx.registry } };
}

function validateNode(schema: Schema, data: unknown, path: string, ctx: Ctx): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: schema is false`];
  const errors: string[] = [];
  const s = schema;

  if (typeof s.$ref === "string") {
    const r = resolveRef(s.$ref, ctx);
    errors.push(...validateNode(r.schema, data, path, r.ctx));
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(t, data))) errors.push(`${path}: expected type ${types.join("|")}, got ${typeOf(data)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, data))) {
    errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  }
  if ("const" in s && !deepEqual(s.const, data)) errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);

  if (typeof data === "string") {
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(data)) errors.push(`${path}: does not match ${s.pattern}`);
    const len = [...data].length;
    if (typeof s.minLength === "number" && len < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && len > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
    if (typeof s.format === "string" && !formatOk(s.format, data)) errors.push(`${path}: not a valid ${s.format}`);
  }

  if (typeof data === "number") {
    if (typeof s.minimum === "number" && data < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && data > s.maximum) errors.push(`${path}: above maximum ${s.maximum}`);
  }

  if (Array.isArray(data)) {
    if (s.items !== undefined) data.forEach((item, i) => errors.push(...validateNode(s.items as Schema, item, `${path}/${i}`, ctx)));
    if (s.contains !== undefined && !data.some((item) => validateNode(s.contains as Schema, item, path, ctx).length === 0)) {
      errors.push(`${path}: no item satisfies "contains"`);
    }
    if (typeof s.minItems === "number" && data.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && data.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    if (s.uniqueItems === true) {
      for (let i = 0; i < data.length; i++) for (let j = i + 1; j < data.length; j++) if (deepEqual(data[i], data[j])) errors.push(`${path}: items ${i} and ${j} are equal`);
    }
  }

  if (isObject(data)) {
    const props = isObject(s.properties) ? (s.properties as Record<string, Schema>) : {};
    if (Array.isArray(s.required)) {
      for (const k of s.required as string[]) if (!Object.prototype.hasOwnProperty.call(data, k)) errors.push(`${path}: missing required property "${k}"`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(data, k)) errors.push(...validateNode(sub, data[k], `${path}/${k}`, ctx));
    }
    if (s.additionalProperties !== undefined) {
      for (const k of Object.keys(data)) {
        if (k in props) continue;
        if (s.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
        else errors.push(...validateNode(s.additionalProperties as Schema, data[k], `${path}/${k}`, ctx));
      }
    }
    if (s.propertyNames !== undefined) {
      for (const k of Object.keys(data)) errors.push(...validateNode(s.propertyNames as Schema, k, `${path}/(name ${k})`, ctx));
    }
  }

  if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) errors.push(...validateNode(sub, data, path, ctx));
  if (Array.isArray(s.anyOf)) {
    const branches = (s.anyOf as Schema[]).map((sub) => validateNode(sub, data, path, ctx));
    if (!branches.some((b) => b.length === 0)) errors.push(`${path}: matches no anyOf branch (${branches.map((b) => b[0]).join(" | ")})`);
  }
  if (Array.isArray(s.oneOf)) {
    const passing = (s.oneOf as Schema[]).filter((sub) => validateNode(sub, data, path, ctx).length === 0).length;
    if (passing !== 1) errors.push(`${path}: must match exactly one oneOf branch, matched ${passing}`);
  }
  if (s.not !== undefined && validateNode(s.not as Schema, data, path, ctx).length === 0) errors.push(`${path}: must not match "not" schema`);
  if (s.if !== undefined) {
    const cond = validateNode(s.if as Schema, data, path, ctx).length === 0;
    if (cond && s.then !== undefined) errors.push(...validateNode(s.then as Schema, data, path, ctx));
    if (!cond && s.else !== undefined) errors.push(...validateNode(s.else as Schema, data, path, ctx));
  }

  return errors;
}

export type ValidationResult = { ok: true; errors: [] } | { ok: false; errors: string[] };

/** Validate `data` against the vendored schema with the given $id. */
export function validateSchema(schemaId: string, data: unknown): ValidationResult {
  const reg = loadRegistry();
  const root = reg.get(schemaId);
  if (!root) throw new Error(`unknown schema ${schemaId}`);
  const errors = validateNode(root, data, "", { root, registry: reg });
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, errors: [] };
}

export class SchemaViolation extends Error {
  constructor(
    readonly schemaId: string,
    readonly what: string,
    readonly errors: string[],
  ) {
    super(`${what} does not conform to ${schemaId}: ${errors.slice(0, 6).join("; ")}${errors.length > 6 ? ` (+${errors.length - 6} more)` : ""}`);
    this.name = "SchemaViolation";
  }
}

/** Throw unless `data` conforms. Used before every write of a program artifact. */
export function assertValid(schemaId: string, data: unknown, what: string): void {
  const r = validateSchema(schemaId, data);
  if (!r.ok) throw new SchemaViolation(schemaId, what, r.errors);
}
