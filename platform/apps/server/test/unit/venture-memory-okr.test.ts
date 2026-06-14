import { describe, it, expect } from "vitest";
import {
  computeKeyResultDrift,
  computeOkrDrift,
  keyResultProgress,
  validateOkrCount,
} from "../../src/venture-memory/okr.js";
import type { KeyResult, OkrRecord } from "../../src/venture-memory/types.js";

function kr(over: Partial<KeyResult> = {}): KeyResult {
  return { metric: "signups", target: 100, current: 50, unit: "count", verified: true, source: "vr_1", ...over };
}

function okr(keyResults: KeyResult[]): OkrRecord {
  return {
    id: "okr_1",
    workspaceId: "ws_1",
    ideaId: "idea_1",
    objective: "Reach product-market fit",
    keyResults,
    status: "active",
    periodKey: "2026-Q2",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("keyResultProgress: clamped current/target", () => {
  it("is the ratio in-range", () => {
    expect(keyResultProgress({ current: 50, target: 100 })).toBe(0.5);
  });
  it("clamps above 1 and below 0, and reads 0 for an ill-formed target", () => {
    expect(keyResultProgress({ current: 200, target: 100 })).toBe(1);
    expect(keyResultProgress({ current: -5, target: 100 })).toBe(0);
    expect(keyResultProgress({ current: 5, target: 0 })).toBe(0);
  });
});

describe("computeKeyResultDrift: verification gates everything (premortem #200)", () => {
  it("an unverified KR is NEVER on_track — no matter how good the number", () => {
    const d = computeKeyResultDrift(kr({ verified: false, current: 100, target: 100, source: null }));
    expect(d.status).toBe("unverified");
  });

  it("a verified KR at/above target is achieved", () => {
    expect(computeKeyResultDrift(kr({ current: 100, target: 100 })).status).toBe("achieved");
  });

  it("a verified KR at/above the pace target is on_track", () => {
    expect(computeKeyResultDrift(kr({ current: 60, target: 100 }), 0.5).status).toBe("on_track");
  });

  it("a verified KR below the pace target is behind", () => {
    expect(computeKeyResultDrift(kr({ current: 40, target: 100 }), 0.5).status).toBe("behind");
  });
});

describe("computeOkrDrift: rolls up the drift flag", () => {
  it("flags drifting when any KR is behind or unverified", () => {
    const d = computeOkrDrift(okr([kr({ current: 100, target: 100 }), kr({ verified: false, source: null })]));
    expect(d.drifting).toBe(true);
    expect(d.verifiedCount).toBe(1);
    expect(d.totalCount).toBe(2);
  });

  it("does not flag when every KR is verified and on/at pace", () => {
    const d = computeOkrDrift(okr([kr({ current: 100, target: 100 }), kr({ current: 90, target: 100 })]), 0.5);
    expect(d.drifting).toBe(false);
  });
});

describe("validateOkrCount: 2–3 objectives per venture", () => {
  it("rejects fewer than 2", () => {
    expect(validateOkrCount({ length: 1 }).ok).toBe(false);
  });
  it("accepts 2 and 3", () => {
    expect(validateOkrCount({ length: 2 }).ok).toBe(true);
    expect(validateOkrCount({ length: 3 }).ok).toBe(true);
  });
  it("rejects more than 3", () => {
    expect(validateOkrCount({ length: 4 }).ok).toBe(false);
  });
});
