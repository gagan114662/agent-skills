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
  claudeConnected: false,
  hasConnection: false,
  agentRan: false,
  resultApproved: false,
};

describe("deriveFirstRunChecklist (#479)", () => {
  it("returns the six steps in setup order", () => {
    expect(deriveFirstRunChecklist(none).map((s) => s.key)).toEqual([
      "target",
      "brand",
      "claude",
      "connect",
      "run",
      "approve",
    ]);
  });

  it("maps each signal to its step's done-state", () => {
    const steps = deriveFirstRunChecklist({
      targetSet: true,
      brandSet: true,
      claudeConnected: false,
      hasConnection: false,
      agentRan: true,
      resultApproved: false,
    });
    expect(steps).toEqual([
      { key: "target", done: true },
      { key: "brand", done: true },
      { key: "claude", done: false },
      { key: "connect", done: false },
      { key: "run", done: true },
      { key: "approve", done: false },
    ]);
  });

  it("progress counts only the real, done steps", () => {
    expect(firstRunProgress(deriveFirstRunChecklist(none))).toEqual({ done: 0, total: 6 });
    expect(
      firstRunProgress(deriveFirstRunChecklist({ ...none, targetSet: true, brandSet: true, claudeConnected: true, hasConnection: true })),
    ).toEqual({ done: 4, total: 6 });
  });

  it("is complete only when every step is real", () => {
    expect(firstRunComplete(deriveFirstRunChecklist(none))).toBe(false);
    expect(
      firstRunComplete(
        deriveFirstRunChecklist({
          targetSet: true,
          brandSet: true,
          claudeConnected: true,
          hasConnection: true,
          agentRan: true,
          resultApproved: true,
        }),
      ),
    ).toBe(true);
  });
});
