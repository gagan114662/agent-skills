/**
 * Pure first-run decision tests (#301 + #299). Lock when the auto-deliverable fires (and, crucially, when
 * it must NOT) and which panel the console shows above the board so a raw runner/exit error never leaks.
 */
import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_MAX_ATTEMPTS,
  firstRunPanel,
  shouldAutoRunFirstRun,
  type AutoRunInput,
} from "./firstrun.js";

const base: AutoRunInput = {
  flagOn: true,
  hasWorkspace: true,
  boardShown: true,
  liveCount: 0,
  deliverableCount: 0,
  busy: false,
  attempts: 0,
  diagnosticState: null,
};

describe("shouldAutoRunFirstRun (#301)", () => {
  it("fires once on a fresh, ready, empty board", () => {
    expect(shouldAutoRunFirstRun(base)).toBe(true);
  });

  it("never fires when the flag is off", () => {
    expect(shouldAutoRunFirstRun({ ...base, flagOn: false })).toBe(false);
  });

  it("never fires without a workspace, while busy, or before the board is shown", () => {
    expect(shouldAutoRunFirstRun({ ...base, hasWorkspace: false })).toBe(false);
    expect(shouldAutoRunFirstRun({ ...base, busy: true })).toBe(false);
    // No-venture empty-state pitch owns its case — the auto-run stays out of it.
    expect(shouldAutoRunFirstRun({ ...base, boardShown: false })).toBe(false);
  });

  it("never fires when value already exists (a live session or a deliverable)", () => {
    expect(shouldAutoRunFirstRun({ ...base, liveCount: 1 })).toBe(false);
    expect(shouldAutoRunFirstRun({ ...base, deliverableCount: 1 })).toBe(false);
  });

  it("retries silently ONLY while failing — not on a healthy idle board", () => {
    expect(shouldAutoRunFirstRun({ ...base, attempts: 1, diagnosticState: "sessions_failing" })).toBe(true);
    expect(shouldAutoRunFirstRun({ ...base, attempts: 1, diagnosticState: "idle" })).toBe(false);
    expect(shouldAutoRunFirstRun({ ...base, attempts: 1, diagnosticState: null })).toBe(false);
  });

  it("gives up after the attempt cap", () => {
    expect(
      shouldAutoRunFirstRun({
        ...base,
        attempts: FIRST_RUN_MAX_ATTEMPTS,
        diagnosticState: "sessions_failing",
      }),
    ).toBe(false);
  });
});

describe("firstRunPanel (#299)", () => {
  it("shows the calm warming-up panel while auto-running OR while sessions are failing — never the raw error", () => {
    expect(firstRunPanel({ autoRunning: true, diagnosticState: null })).toBe("warming");
    expect(firstRunPanel({ autoRunning: false, diagnosticState: "sessions_failing" })).toBe("warming");
  });

  it("keeps the calm server diagnostic for no_work / idle", () => {
    expect(firstRunPanel({ autoRunning: false, diagnosticState: "no_work" })).toBe("diagnostic");
    expect(firstRunPanel({ autoRunning: false, diagnosticState: "idle" })).toBe("diagnostic");
  });

  it("renders nothing for running / no_venture / unknown", () => {
    expect(firstRunPanel({ autoRunning: false, diagnosticState: "running" })).toBe("none");
    expect(firstRunPanel({ autoRunning: false, diagnosticState: "no_venture" })).toBe("none");
    expect(firstRunPanel({ autoRunning: false, diagnosticState: null })).toBe("none");
  });
});
