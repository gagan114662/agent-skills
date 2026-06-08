import { describe, it, expect } from "vitest";
import { validate, validateDef, type JsonSchema } from "../../src/protocols/jsonschema.js";

/**
 * The dependency-free JSON-Schema validator (#12) underpins protocol conformance: it checks that
 * the A2A/ACP objects our adapters emit match the vendored published schemas. These hermetic tests
 * pin the exact keyword subset it must support — and prove it rejects, not just accepts.
 */
describe("jsonschema validator", () => {
  it("checks primitive types, including integer vs number and unions", () => {
    expect(validate({ type: "string" }, "x").valid).toBe(true);
    expect(validate({ type: "string" }, 1).valid).toBe(false);
    expect(validate({ type: "integer" }, 3).valid).toBe(true);
    expect(validate({ type: "integer" }, 3.5).valid).toBe(false);
    expect(validate({ type: "number" }, 3.5).valid).toBe(true);
    expect(validate({ type: ["string", "null"] }, null).valid).toBe(true);
    expect(validate({ type: ["string", "null"] }, 7).valid).toBe(false);
  });

  it("enforces enum and const", () => {
    expect(validate({ enum: ["a", "b"] }, "a").valid).toBe(true);
    expect(validate({ enum: ["a", "b"] }, "c").valid).toBe(false);
    expect(validate({ const: "task" }, "task").valid).toBe(true);
    expect(validate({ const: "task" }, "message").valid).toBe(false);
  });

  it("requires properties and (optionally) forbids extras", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["a"],
      additionalProperties: false,
      properties: { a: { type: "string" }, b: { type: "number" } },
    };
    expect(validate(schema, { a: "x" }).valid).toBe(true);
    expect(validate(schema, { b: 1 }).valid).toBe(false); // missing required a
    expect(validate(schema, { a: "x", c: 1 }).valid).toBe(false); // extra c
    expect(validate(schema, { a: 1 }).valid).toBe(false); // wrong type
  });

  it("validates array items", () => {
    const schema: JsonSchema = { type: "array", items: { type: "string" } };
    expect(validate(schema, ["a", "b"]).valid).toBe(true);
    expect(validate(schema, ["a", 2]).valid).toBe(false);
  });

  it("resolves local $ref into $defs", () => {
    const doc: JsonSchema = {
      $defs: { Name: { type: "string" } },
    };
    expect(validateDef(doc, "Name", "x").valid).toBe(true);
    expect(validateDef(doc, "Name", 5).valid).toBe(false);
  });

  it("enforces oneOf (exactly one branch)", () => {
    const schema: JsonSchema = {
      oneOf: [
        { type: "object", required: ["kind"], properties: { kind: { const: "text" } } },
        { type: "object", required: ["kind"], properties: { kind: { const: "data" } } },
      ],
    };
    expect(validate(schema, { kind: "text" }).valid).toBe(true);
    expect(validate(schema, { kind: "data" }).valid).toBe(true);
    expect(validate(schema, { kind: "other" }).valid).toBe(false); // zero branches
  });

  it("returns descriptive error paths", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { status: { type: "object", properties: { state: { type: "string" } } } },
    };
    const res = validate(schema, { status: { state: 9 } });
    expect(res.valid).toBe(false);
    expect(res.errors[0].path).toBe("/status/state");
  });
});
