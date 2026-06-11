import { describe, it, expect } from "vitest";
import {
  computeReliabilityInsights,
  type InsightIncident,
} from "../../src/reliability/insights/aggregate.js";

const NOW = new Date("2026-06-11T12:00:00Z");

function inc(overrides: Partial<InsightIncident> = {}): InsightIncident {
  return {
    service: "api",
    status: "resolved",
    openedAt: new Date("2026-06-11T10:00:00Z"),
    resolvedAt: new Date("2026-06-11T10:30:00Z"), // 30 min MTTR
    ...overrides,
  };
}

describe("computeReliabilityInsights — MTTR", () => {
  it("averages resolve − open over resolved incidents only", () => {
    const insights = computeReliabilityInsights(
      [
        inc({ openedAt: new Date("2026-06-11T10:00:00Z"), resolvedAt: new Date("2026-06-11T10:20:00Z") }), // 20m
        inc({ openedAt: new Date("2026-06-11T09:00:00Z"), resolvedAt: new Date("2026-06-11T10:00:00Z") }), // 60m
        inc({ status: "firing", resolvedAt: null }), // open — excluded
      ],
      NOW,
    );
    expect(insights.mttrMs).toBe(40 * 60_000); // (20 + 60) / 2
  });

  it("returns null MTTR when nothing has resolved", () => {
    expect(computeReliabilityInsights([inc({ status: "firing", resolvedAt: null })], NOW).mttrMs).toBeNull();
  });
});

describe("computeReliabilityInsights — frequency + open count", () => {
  it("counts incidents opened within the 7d and 30d windows", () => {
    const insights = computeReliabilityInsights(
      [
        inc({ openedAt: new Date("2026-06-10T12:00:00Z") }), // 1d ago → in 7d + 30d
        inc({ openedAt: new Date("2026-06-02T12:00:00Z") }), // 9d ago → in 30d only
        inc({ openedAt: new Date("2026-04-01T12:00:00Z") }), // ~71d ago → in neither
      ],
      NOW,
    );
    expect(insights.incidentsLast7d).toBe(1);
    expect(insights.incidentsLast30d).toBe(2);
    expect(insights.total).toBe(3);
  });

  it("counts active (non-resolved) incidents as open", () => {
    const insights = computeReliabilityInsights(
      [inc({ status: "firing", resolvedAt: null }), inc({ status: "escalated", resolvedAt: null }), inc()],
      NOW,
    );
    expect(insights.openCount).toBe(2);
  });
});

describe("computeReliabilityInsights — noisiest components", () => {
  it("ranks services by incident count, descending", () => {
    const insights = computeReliabilityInsights(
      [inc({ service: "api" }), inc({ service: "api" }), inc({ service: "db" }), inc({ service: "api" })],
      NOW,
    );
    expect(insights.noisiestComponents[0]).toEqual({ service: "api", count: 3 });
    expect(insights.noisiestComponents[1]).toEqual({ service: "db", count: 1 });
  });

  it("returns an empty insight set for no incidents", () => {
    const insights = computeReliabilityInsights([], NOW);
    expect(insights).toEqual({
      mttrMs: null,
      incidentsLast7d: 0,
      incidentsLast30d: 0,
      openCount: 0,
      total: 0,
      noisiestComponents: [],
    });
  });
});
