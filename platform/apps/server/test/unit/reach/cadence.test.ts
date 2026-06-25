import { describe, expect, it } from "vitest";
import {
  DEFAULT_CADENCE,
  nextDueStep,
  type CadenceEnrollment,
} from "../../../src/reach/cadence.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 5, 16, 12, 0, 0);

function enrollment(over: Partial<CadenceEnrollment> = {}): CadenceEnrollment {
  return {
    contactKey: "email:ada@example.com",
    currentStep: 1,
    lastStepAtMs: START,
    status: "active",
    ...over,
  };
}

describe("reach cadence engagement decisions (#886)", () => {
  it("keeps the fixed baseline for no-signal prospects before the cold pause", () => {
    expect(nextDueStep(enrollment(), DEFAULT_CADENCE, START + 2 * DAY_MS)).toBeNull();
    expect(nextDueStep(enrollment(), DEFAULT_CADENCE, START + 3 * DAY_MS)).toEqual(
      DEFAULT_CADENCE[1],
    );
  });

  it("accelerates an engaged prospect instead of waiting for the fixed baseline", () => {
    const step = nextDueStep(enrollment(), DEFAULT_CADENCE, START + DAY_MS, {
      engagement: { opensCount: 1, lastOpenAtMs: START + 60_000, hasReplied: false },
    });

    expect(step).toEqual(DEFAULT_CADENCE[1]);
  });

  it("pauses a silent prospect after the cold threshold", () => {
    const step = nextDueStep(enrollment(), DEFAULT_CADENCE, START + 14 * DAY_MS, {
      engagement: { opensCount: 0, lastOpenAtMs: null, hasReplied: false },
    });

    expect(step).toBeNull();
  });

  it("does not keep following up after a reply receipt", () => {
    const step = nextDueStep(enrollment(), DEFAULT_CADENCE, START + DAY_MS, {
      engagement: { opensCount: 3, lastOpenAtMs: START + 60_000, hasReplied: true },
    });

    expect(step).toBeNull();
  });
});
