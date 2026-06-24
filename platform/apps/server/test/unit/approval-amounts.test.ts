import { describe, expect, it } from "vitest";
import { MAX_APPROVAL_AMOUNT, parseApprovalAmount } from "../../src/routes/approvals.js";

describe("approval route amount bounds", () => {
  it.each([
    ["amount", -1],
    ["amount", Number.NaN],
    ["amount", Number.POSITIVE_INFINITY],
    ["amount", MAX_APPROVAL_AMOUNT + 1],
    ["maxAutoAmount", -1],
    ["maxAutoAmount", Number.NaN],
    ["maxAutoAmount", Number.POSITIVE_INFINITY],
    ["maxAutoAmount", MAX_APPROVAL_AMOUNT + 1],
  ])("rejects invalid %s=%s", (field, value) => {
    expect(parseApprovalAmount(value, field).ok).toBe(false);
  });

  it("accepts omitted, zero, and max-bound amounts", () => {
    expect(parseApprovalAmount(undefined, "amount")).toEqual({ ok: true, value: null });
    expect(parseApprovalAmount(null, "amount")).toEqual({ ok: true, value: null });
    expect(parseApprovalAmount(0, "amount")).toEqual({ ok: true, value: 0 });
    expect(parseApprovalAmount(MAX_APPROVAL_AMOUNT, "amount")).toEqual({
      ok: true,
      value: MAX_APPROVAL_AMOUNT,
    });
  });
});
