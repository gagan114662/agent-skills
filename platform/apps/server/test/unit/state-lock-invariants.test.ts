import { describe, it, expect } from "vitest";
import {
  checkRecord,
  checkTransition,
  checkVersionHistory,
  assertRecord,
  assertTransition,
} from "../../src/state-lock/invariants.js";
import { InvariantViolationError, type SharedStateRecord } from "../../src/state-lock/types.js";

const base: SharedStateRecord<{ n: number }> = {
  workspaceId: "ws-1",
  key: "counter",
  version: 1,
  value: { n: 0 },
  updatedAtMs: 1000,
};

describe("checkRecord", () => {
  it("accepts a well-formed record", () => {
    expect(checkRecord(base)).toBeNull();
  });

  it.each([
    ["empty key", { ...base, key: "" }],
    ["empty workspaceId", { ...base, workspaceId: "" }],
    ["version below 1", { ...base, version: 0 }],
    ["non-integer version", { ...base, version: 1.5 }],
    ["non-finite timestamp", { ...base, updatedAtMs: Number.NaN }],
  ])("rejects %s", (_label, record) => {
    expect(checkRecord(record as SharedStateRecord)).not.toBeNull();
  });
});

describe("checkTransition", () => {
  it("accepts a single-step version advance with stable identity", () => {
    const next = { ...base, version: 2, value: { n: 1 } };
    expect(checkTransition(base, next)).toBeNull();
  });

  it("rejects a version that did not advance by exactly one (lost-update signature)", () => {
    expect(checkTransition(base, { ...base, version: 1 })).toMatch(/advance by one/);
    expect(checkTransition(base, { ...base, version: 3 })).toMatch(/advance by one/);
  });

  it("rejects an identity that changed under the write", () => {
    expect(checkTransition(base, { ...base, version: 2, key: "other" })).toMatch(/key changed/);
    expect(checkTransition(base, { ...base, version: 2, workspaceId: "ws-2" })).toMatch(/workspaceId changed/);
  });
});

describe("checkVersionHistory", () => {
  it("accepts a gap-free run", () => {
    expect(checkVersionHistory([1, 2, 3, 4, 5])).toBeNull();
    expect(checkVersionHistory([])).toBeNull();
  });

  it("flags a skipped version (an update was silently lost)", () => {
    expect(checkVersionHistory([1, 2, 4])).toMatch(/broke at index 2/);
  });

  it("flags a repeated version (two writers committed the same number)", () => {
    expect(checkVersionHistory([1, 2, 2, 3])).toMatch(/broke at index 2/);
  });
});

describe("assert* throwers", () => {
  it("assertRecord throws InvariantViolationError on a bad record", () => {
    expect(() => assertRecord({ ...base, version: 0 })).toThrow(InvariantViolationError);
  });

  it("assertTransition throws InvariantViolationError on a bad transition", () => {
    expect(() => assertTransition(base, { ...base, version: 5 })).toThrow(InvariantViolationError);
  });

  it("assertTransition is silent on a valid transition", () => {
    expect(() => assertTransition(base, { ...base, version: 2 })).not.toThrow();
  });
});
