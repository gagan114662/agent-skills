import { describe, it, expect } from "vitest";
import { decidePage, type PageInput } from "../../src/reliability/paging/decide.js";

const NOON = new Date("2026-06-11T12:00:00Z"); // 12:00 UTC — outside the default quiet window

/** A delivering baseline: an enabled, fresh, un-acked, un-rate-limited `opened` warning page. */
function base(overrides: Partial<PageInput> = {}): PageInput {
  return {
    enabled: true,
    now: NOON,
    kind: "opened",
    severity: "warning",
    quietHours: null,
    lastPagedAt: null,
    ackedAt: null,
    escalateAfterMs: 15 * 60_000,
    recentPageCount: 0,
    maxPagesPerWindow: 6,
    pageOnResolve: true,
    ...overrides,
  };
}

describe("decidePage — gating order", () => {
  it("suppresses when reliability is disabled", () => {
    expect(decidePage(base({ enabled: false }))).toEqual({ deliver: false, reason: "disabled" });
  });

  it("suppresses once the rate-limit window is full", () => {
    expect(decidePage(base({ recentPageCount: 6, maxPagesPerWindow: 6 }))).toEqual({
      deliver: false,
      reason: "rate_limited",
    });
  });

  it("rate-limit caps even a critical page (noise control on a sustained breach)", () => {
    const d = decidePage(base({ severity: "critical", recentPageCount: 10, maxPagesPerWindow: 6 }));
    expect(d.deliver).toBe(false);
    expect(d.reason).toBe("rate_limited");
  });

  it("delivers a fresh opened page", () => {
    expect(decidePage(base())).toEqual({ deliver: true, reason: "opened" });
  });
});

describe("decidePage — quiet hours", () => {
  // Window 22:00 → 06:00 UTC (wraps midnight). 03:00 is inside; 12:00 is outside.
  const quiet = { startHourUtc: 22, endHourUtc: 6 };
  const inWindow = new Date("2026-06-11T03:00:00Z");

  it("holds a warning page inside quiet hours", () => {
    const d = decidePage(base({ quietHours: quiet, now: inWindow }));
    expect(d).toEqual({ deliver: false, reason: "quiet_hours" });
  });

  it("lets a critical page break through quiet hours", () => {
    const d = decidePage(base({ quietHours: quiet, now: inWindow, severity: "critical" }));
    expect(d.deliver).toBe(true);
  });

  it("does not hold a page outside the quiet window", () => {
    const d = decidePage(base({ quietHours: quiet, now: NOON }));
    expect(d.deliver).toBe(true);
  });

  it("treats start === end as no quiet window (delivers)", () => {
    const d = decidePage(base({ quietHours: { startHourUtc: 5, endHourUtc: 5 }, now: new Date("2026-06-11T05:00:00Z") }));
    expect(d.deliver).toBe(true);
  });

  it("handles a non-wrapping window (09:00 → 17:00)", () => {
    const day = { startHourUtc: 9, endHourUtc: 17 };
    expect(decidePage(base({ quietHours: day, now: new Date("2026-06-11T10:00:00Z") })).reason).toBe("quiet_hours");
    expect(decidePage(base({ quietHours: day, now: new Date("2026-06-11T18:00:00Z") })).deliver).toBe(true);
  });
});

describe("decidePage — escalation re-page (kind=repaged)", () => {
  it("suppresses a re-page once the incident is acknowledged", () => {
    const d = decidePage(base({ kind: "repaged", ackedAt: new Date("2026-06-11T11:50:00Z") }));
    expect(d).toEqual({ deliver: false, reason: "acknowledged" });
  });

  it("suppresses a re-page still inside the escalation cooldown", () => {
    const d = decidePage(
      base({ kind: "repaged", lastPagedAt: new Date("2026-06-11T11:55:00Z") }), // 5 min ago < 15 min
    );
    expect(d).toEqual({ deliver: false, reason: "cooldown" });
  });

  it("re-pages an unacked incident once the escalation interval has elapsed", () => {
    const d = decidePage(
      base({ kind: "repaged", lastPagedAt: new Date("2026-06-11T11:40:00Z") }), // 20 min ago > 15 min
    );
    expect(d).toEqual({ deliver: true, reason: "escalation" });
  });
});

describe("decidePage — resolved / recovery pages", () => {
  it("delivers a resolved page when pageOnResolve is on", () => {
    expect(decidePage(base({ kind: "resolved" }))).toEqual({ deliver: true, reason: "resolved" });
  });

  it("suppresses a resolved page when pageOnResolve is off", () => {
    expect(decidePage(base({ kind: "resolved", pageOnResolve: false }))).toEqual({
      deliver: false,
      reason: "resolve_suppressed",
    });
  });

  it("delivers a resolved page even inside quiet hours (closure is not held)", () => {
    const d = decidePage(
      base({ kind: "resolved", quietHours: { startHourUtc: 0, endHourUtc: 23 }, now: new Date("2026-06-11T03:00:00Z") }),
    );
    expect(d.deliver).toBe(true);
  });
});

describe("decidePage — uptime kinds", () => {
  it("delivers an uptime_down page like an opened incident", () => {
    expect(decidePage(base({ kind: "uptime_down" })).deliver).toBe(true);
  });

  it("treats uptime_recover as a resolution (respects pageOnResolve)", () => {
    expect(decidePage(base({ kind: "uptime_recover", pageOnResolve: false })).deliver).toBe(false);
  });
});
