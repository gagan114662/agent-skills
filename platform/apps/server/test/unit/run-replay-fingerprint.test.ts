import { describe, it, expect } from "vitest";
import { canonicalize, fingerprint } from "../../src/run-replay/fingerprint.js";

describe("canonicalize", () => {
  it("emits object keys in sorted order, recursively", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("is insensitive to key insertion order but sensitive to content", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });

  it("preserves array order (it is meaningful)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("normalizes undefined to null", () => {
    expect(canonicalize(undefined)).toBe("null");
    expect(canonicalize({ a: undefined })).toBe('{"a":null}');
  });
});

describe("fingerprint", () => {
  it("is a 64-char hex SHA-256 digest", () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across key order (the reproducibility guarantee)", () => {
    expect(fingerprint({ prompt: "p", seed: 7, config: { a: 1, b: 2 } })).toBe(
      fingerprint({ config: { b: 2, a: 1 }, seed: 7, prompt: "p" }),
    );
  });

  it("changes when any captured input changes", () => {
    const base = fingerprint({ prompt: "p", seed: 7 });
    expect(fingerprint({ prompt: "p", seed: 8 })).not.toBe(base); // different seed
    expect(fingerprint({ prompt: "q", seed: 7 })).not.toBe(base); // different prompt
  });
});
