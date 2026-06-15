import { describe, it, expect } from "vitest";
import { computeNextRun, isDue } from "../../src/automations/schedule.js";
import { decideAutomationRun } from "../../src/automations/decide.js";
import { resolveAutomationCaps, AUTOMATION_DEFAULTS } from "../../src/automations/caps.js";
import {
  TASK_TEMPLATES,
  getTemplate,
  templatesForDepartment,
  renderTemplate,
} from "../../src/automations/templates.js";
import type { AutomationRunDecisionInput } from "../../src/automations/types.js";

describe("automations schedule (#147)", () => {
  it("interval cadence advances by everyMinutes", () => {
    const from = new Date("2026-06-08T09:00:00.000Z");
    expect(computeNextRun({ cadence: "interval", everyMinutes: 30 }, from)?.toISOString()).toBe(
      "2026-06-08T09:30:00.000Z",
    );
  });

  it("interval cadence clamps a non-positive everyMinutes to >= 1", () => {
    const from = new Date("2026-06-08T09:00:00.000Z");
    const next = computeNextRun({ cadence: "interval", everyMinutes: 0 }, from);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it("hourly cadence lands on the next occurrence of the target minute", () => {
    const from = new Date("2026-06-08T09:20:00.000Z");
    expect(computeNextRun({ cadence: "hourly", minute: 15 }, from)?.toISOString()).toBe(
      "2026-06-08T10:15:00.000Z",
    );
  });

  it("daily cadence rolls to tomorrow when the time has passed today", () => {
    const from = new Date("2026-06-08T10:00:00.000Z");
    expect(computeNextRun({ cadence: "daily", hour: 9, minute: 0 }, from)?.toISOString()).toBe(
      "2026-06-09T09:00:00.000Z",
    );
  });

  it("daily cadence stays today when the time is still ahead", () => {
    const from = new Date("2026-06-08T08:00:00.000Z");
    expect(computeNextRun({ cadence: "daily", hour: 9, minute: 30 }, from)?.toISOString()).toBe(
      "2026-06-08T09:30:00.000Z",
    );
  });

  it("weekly cadence finds the next Monday 09:00 (the headline example)", () => {
    // 2026-06-08 is a Monday; from 10:00 that Monday, the next Monday-09:00 is a week later.
    const from = new Date("2026-06-08T10:00:00.000Z");
    const next = computeNextRun({ cadence: "weekly", dayOfWeek: 1, hour: 9, minute: 0 }, from);
    expect(next?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
    expect(next?.getUTCDay()).toBe(1);
  });

  it("weekly cadence reaches a later weekday in the same week", () => {
    // From Monday, the next Friday (5) at 09:00 is the same week.
    const from = new Date("2026-06-08T10:00:00.000Z");
    expect(
      computeNextRun({ cadence: "weekly", dayOfWeek: 5, hour: 9, minute: 0 }, from)?.toISOString(),
    ).toBe("2026-06-12T09:00:00.000Z");
  });

  it("always returns an instant strictly after `from` (no immediate re-fire)", () => {
    const from = new Date("2026-06-08T09:00:00.000Z");
    for (const schedule of [
      { cadence: "interval" as const, everyMinutes: 60 },
      { cadence: "hourly" as const, minute: 0 },
      { cadence: "daily" as const, hour: 9, minute: 0 },
      { cadence: "weekly" as const, dayOfWeek: 1, hour: 9, minute: 0 },
    ]) {
      expect(computeNextRun(schedule, from)!.getTime()).toBeGreaterThan(from.getTime());
    }
  });

  it("isDue compares the cursor against now; null cursor is never due", () => {
    const now = new Date("2026-06-08T09:00:00.000Z");
    expect(isDue(new Date("2026-06-08T08:59:00.000Z"), now)).toBe(true);
    expect(isDue(new Date("2026-06-08T09:00:00.000Z"), now)).toBe(true);
    expect(isDue(new Date("2026-06-08T09:01:00.000Z"), now)).toBe(false);
    expect(isDue(null, now)).toBe(false);
  });
});

describe("automations decide (#147)", () => {
  const base: AutomationRunDecisionInput = {
    capsEnabled: true,
    automationEnabled: true,
    killSwitch: false,
    due: true,
    runsInWindow: 0,
    maxRunsPerWindow: 10,
  };

  it("runs when enabled, due, and under the rate cap", () => {
    expect(decideAutomationRun(base)).toEqual({ action: "run", reason: "due" });
  });

  it("skips first on caps disabled, then automation disabled, then kill switch", () => {
    expect(decideAutomationRun({ ...base, capsEnabled: false }).reason).toBe("automations_disabled");
    expect(decideAutomationRun({ ...base, automationEnabled: false }).reason).toBe("automation_disabled");
    expect(decideAutomationRun({ ...base, killSwitch: true }).reason).toBe("kill_switch");
  });

  it("skips when not due", () => {
    expect(decideAutomationRun({ ...base, due: false })).toEqual({ action: "skip", reason: "not_due" });
  });

  it("rate-limits at the window cap", () => {
    expect(decideAutomationRun({ ...base, runsInWindow: 10, maxRunsPerWindow: 10 }).reason).toBe(
      "rate_limited",
    );
  });
});

describe("automations caps (#147)", () => {
  it("defaults to OFF with hard rate bounds", () => {
    expect(resolveAutomationCaps(undefined)).toEqual(AUTOMATION_DEFAULTS);
    expect(resolveAutomationCaps(undefined).enabled).toBe(false);
  });

  it("an explicit config overrides only the set fields", () => {
    const caps = resolveAutomationCaps({ enabled: true, maxRunsPerWindow: 3 });
    expect(caps.enabled).toBe(true);
    expect(caps.maxRunsPerWindow).toBe(3);
    expect(caps.windowMinutes).toBe(AUTOMATION_DEFAULTS.windowMinutes);
  });
});

describe("automations templates (#147)", () => {
  it("ships six department templates that all resolve", () => {
    expect(TASK_TEMPLATES.length).toBe(6);
    for (const t of TASK_TEMPLATES) {
      expect(getTemplate(t.key)).toBe(t);
      expect(templatesForDepartment(t.department)).toContain(t);
    }
  });

  it("renders placeholders from params and falls back to defaults", () => {
    const rendered = renderTemplate("seo_audit", { site: "ipop.ai" });
    expect(rendered).toContain("ipop.ai");
    expect(rendered).not.toContain("{{site}}");
  });

  it("uses the param placeholder when a value is missing or blank", () => {
    expect(renderTemplate("seo_audit", {})).toContain("our website");
    expect(renderTemplate("seo_audit", { site: "  " })).toContain("our website");
  });

  it("renders a real site URL into {{site}} when supplied (#250)", () => {
    const rendered = renderTemplate("seo_audit", { site: "https://ipop.ai" });
    expect(rendered).toContain("https://ipop.ai");
    expect(rendered).not.toContain("our website");
    expect(rendered).not.toContain("{{site}}");
  });

  it("returns empty string for an unknown template", () => {
    expect(renderTemplate("nope", {})).toBe("");
    expect(getTemplate("nope")).toBeUndefined();
  });
});
