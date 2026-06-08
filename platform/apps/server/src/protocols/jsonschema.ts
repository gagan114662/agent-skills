/**
 * A small, dependency-free JSON-Schema validator (issue #12).
 *
 * We use this to prove **conformance**: that the A2A / ACP objects our adapters emit validate
 * against the *published* protocol schemas (vendored as fixtures). We deliberately hand-roll it
 * rather than add `ajv`, for the same reason #11 hand-wrote its OpenAPI types instead of pulling in
 * `@fastify/swagger`: no new dependency, no install/network in the build gates, and a tiny surface
 * that is itself unit-tested. It is *not* a general-purpose draft-2020-12 implementation — it
 * supports exactly the keywords the vendored A2A/ACP schema subsets use:
 *
 *   $ref (local JSON-pointer into $defs/definitions), type (incl. unions), enum, const,
 *   properties, required, items, additionalProperties (boolean), oneOf, anyOf, allOf.
 *
 * Annotation/metadata keywords ($schema, $id, title, description, examples, default, format,
 * x-source, …) are intentionally ignored. Unknown keywords are ignored, never fatal.
 */

export type JsonSchema = Record<string, unknown> | boolean;

export interface ValidationError {
  /** JSON-pointer-ish path to the offending value (e.g. `/status/state`). */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

type Json = unknown;

const typeOfJson = (value: Json): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "object" | "string" | "number" | "boolean" | "undefined" | …
};

const matchesType = (value: Json, type: string): boolean => {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  return typeOfJson(value) === type;
};

/** Resolve a local `$ref` (`#/$defs/X`, `#/definitions/X`, `#/components/schemas/X`) against the root. */
function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith("#/")) {
    throw new Error(`jsonschema: only local #/ refs are supported, got "${ref}"`);
  }
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: Json = root;
  for (const seg of segments) {
    if (typeof node !== "object" || node === null || !(seg in (node as Record<string, Json>))) {
      throw new Error(`jsonschema: cannot resolve $ref "${ref}" (missing "${seg}")`);
    }
    node = (node as Record<string, Json>)[seg];
  }
  return node as JsonSchema;
}

function check(schema: JsonSchema, data: Json, path: string, root: JsonSchema): ValidationError[] {
  // Boolean schemas: `true` accepts anything, `false` rejects everything.
  if (schema === true) return [];
  if (schema === false) return [{ path, message: "schema is false (no value allowed)" }];

  const s = schema;
  const errors: ValidationError[] = [];

  if (typeof s.$ref === "string") {
    return check(resolveRef(s.$ref, root), data, path, root);
  }

  // type (string | string[])
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push({ path, message: `expected type ${types.join("|")}, got ${typeOfJson(data)}` });
      // Type mismatch makes deeper keyword checks meaningless; stop here.
      return errors;
    }
  }

  // const
  if ("const" in s && JSON.stringify(data) !== JSON.stringify(s.const)) {
    errors.push({ path, message: `expected const ${JSON.stringify(s.const)}` });
  }

  // enum
  if (Array.isArray(s.enum)) {
    const ok = s.enum.some((e) => JSON.stringify(e) === JSON.stringify(data));
    if (!ok) errors.push({ path, message: `value not in enum ${JSON.stringify(s.enum)}` });
  }

  // object keywords
  if (typeOfJson(data) === "object") {
    const obj = data as Record<string, Json>;
    const props = (s.properties as Record<string, JsonSchema> | undefined) ?? {};

    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!(key in obj)) errors.push({ path: `${path}/${key}`, message: "required property missing" });
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      const childPath = `${path}/${key}`;
      if (key in props) {
        errors.push(...check(props[key]!, value, childPath, root));
      } else if (s.additionalProperties === false) {
        errors.push({ path: childPath, message: "additional property not allowed" });
      } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
        errors.push(...check(s.additionalProperties as JsonSchema, value, childPath, root));
      }
    }
  }

  // array keywords
  if (typeOfJson(data) === "array" && s.items !== undefined) {
    const items = s.items as JsonSchema;
    (data as Json[]).forEach((item, i) => {
      errors.push(...check(items, item, `${path}/${i}`, root));
    });
  }

  // allOf — must satisfy every subschema
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf as JsonSchema[]) {
      errors.push(...check(sub, data, path, root));
    }
  }

  // anyOf — at least one subschema must pass
  if (Array.isArray(s.anyOf)) {
    const ok = (s.anyOf as JsonSchema[]).some((sub) => check(sub, data, path, root).length === 0);
    if (!ok) errors.push({ path, message: "value did not match anyOf" });
  }

  // oneOf — exactly one subschema must pass
  if (Array.isArray(s.oneOf)) {
    const matches = (s.oneOf as JsonSchema[]).filter(
      (sub) => check(sub, data, path, root).length === 0,
    ).length;
    if (matches !== 1) errors.push({ path, message: `value matched ${matches} oneOf branches (need 1)` });
  }

  return errors;
}

/**
 * Validate `data` against `schema`. `$ref`s resolve against `opts.root` (defaults to `schema`,
 * so a self-contained document with `$defs` validates out of the box). To validate against one
 * definition of a larger document, pass `{ $ref: "#/$defs/Name" }` as the schema and the whole
 * document as `root`.
 */
export function validate(
  schema: JsonSchema,
  data: Json,
  opts: { root?: JsonSchema } = {},
): ValidationResult {
  const errors = check(schema, data, "", opts.root ?? schema);
  return { valid: errors.length === 0, errors };
}

/** Convenience: validate `data` against the `$defs[name]` of a self-contained schema document. */
export function validateDef(doc: JsonSchema, name: string, data: Json): ValidationResult {
  return validate({ $ref: `#/$defs/${name}` }, data, { root: doc });
}
