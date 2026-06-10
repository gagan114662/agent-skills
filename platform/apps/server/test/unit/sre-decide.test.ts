import { describe, it, expect } from "vitest";
import { decideAlert } from "../../src/sre/decide.js";
import type { IncidentSeverity } from "../../src/sre/types.js";

const base = {
  breached: false,
  severity: "warning" as IncidentSeverity,
  hasOpenIncident: false,
  killSwitch: false,
  cooldownElapsed: false,
};

describe("decideAlert — the pure on-call decision", () => {
  it("kill switch halts before anything else", () => {
    const d = decideAlert({ ...base, breached: true, killSwitch: true });
    expect(d.action).toBe("noop");
    expect(d.reason).toBe("kill_switch");
  });

  it("healthy with no open incident is a noop", () => {
    expect(decideAlert({ ...base }).action).toBe("noop");
    expect(decideAlert({ ...base }).reason).toBe("healthy");
  });

  it("recovery of an open incident resolves it", () => {
    const d = decideAlert({ ...base, breached: false, hasOpenIncident: true });
    expect(d.action).toBe("resolve");
    expect(d.reason).toBe("recovered");
  });

  it("a fresh warning breach opens an incident", () => {
    const d = decideAlert({ ...base, breached: true, severity: "warning" });
    expect(d.action).toBe("open");
    expect(d.severity).toBe("warning");
  });

  it("a fresh critical breach escalates (risky remediation needs a human)", () => {
    const d = decideAlert({ ...base, breached: true, severity: "critical" });
    expect(d.action).toBe("escalate");
    expect(d.severity).toBe("critical");
    expect(d.reason).toBe("budget_exhausted");
  });

  it("a still-breached open incident re-pages only past the cooldown", () => {
    expect(
      decideAlert({ ...base, breached: true, hasOpenIncident: true, cooldownElapsed: false }).action,
    ).toBe("noop");
    const repage = decideAlert({
      ...base,
      breached: true,
      hasOpenIncident: true,
      cooldownElapsed: true,
    });
    expect(repage.action).toBe("notify");
    expect(repage.reason).toBe("re_page");
  });
});
