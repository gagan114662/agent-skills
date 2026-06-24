import { describe, it, expect } from "vitest";
import {
  deriveFirstRunChecklist,
  firstRunProgress,
  firstRunComplete,
  type FirstRunSignals,
} from "./firstrun-checklist.js";

const none: FirstRunSignals = {
  targetSet: false,
  brandSet: false,
  hasConnection: false,
  agentRan: false,
  resultApproved: false,
};

describe("deriveFirstRunChecklist (#479)", () => {
  it("returns the five steps in setup order", () => {
    expect(deriveFirstRunChecklist(none).map((s) => s.key)).toEqual([
      "target",
      "brand",
      "connect",
      "run",
      "approve",
    ]);
  });

  it("maps each signal to its step's done-state", () => {
    const steps = deriveFirstRunChecklist({
      targetSet: true,
      brandSet: true,
      hasConnection: false,
      agentRan: true,
      resultApproved: false,
    });
    expect(steps).toEqual([
      { key: "target", done: true },
      { key: "brand", done: true },
      { key: "connect", done: false },
      { key: "run", done: true },
      { key: "approve", done: false },
    ]);
  });

  it("progress counts only the real, done steps", () => {
    expect(firstRunProgress(deriveFirstRunChecklist(none))).toEqual({ done: 0, total: 5 });
    expect(
      firstRunProgress(deriveFirstRunChecklist({ ...none, targetSet: true, brandSet: true, hasConnection: true })),
    ).toEqual({ done: 3, total: 5 });
  });

  it("is complete only when every step is real", () => {
    expect(firstRunComplete(deriveFirstRunChecklist(none))).toBe(false);
    expect(
      firstRunComplete(
        deriveFirstRunChecklist({
          targetSet: true,
          brandSet: true,
          hasConnection: true,
          agentRan: true,
          resultApproved: true,
        }),
      ),
    ).toBe(true);
  });
});
