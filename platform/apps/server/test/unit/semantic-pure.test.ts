import { describe, it, expect } from "vitest";
import {
  METRIC_CATALOG,
  getMetric,
  isMetricId,
  listMetrics,
} from "../../src/semantic/catalog.js";
import {
  computeFreshness,
  formatAge,
  isFallbackPath,
  PATH_RANK,
} from "../../src/semantic/provenance.js";
import { buildAnswer, renderValue } from "../../src/semantic/answer.js";

describe("semantic catalog (#155)", () => {
  it("has unique, stable, dotted ids each bound to a known source", () => {
    const ids = METRIC_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const m of METRIC_CATALOG) {
      expect(m.id).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(["growth", "demand", "venture", "moat", "usage"]).toContain(m.source);
    }
  });

  it("getMetric / isMetricId resolve known ids and reject unknown ones", () => {
    expect(getMetric("growth.score")?.unit).toBe("score_0_100");
    expect(getMetric("nope.nope")).toBeUndefined();
    expect(isMetricId("moat.score")).toBe(true);
    expect(isMetricId("definitely.not")).toBe(false);
    expect(isMetricId(42)).toBe(false);
  });

  it("listMetrics filters by source", () => {
    expect(listMetrics("growth").every((m) => m.source === "growth")).toBe(true);
    expect(listMetrics().length).toBe(METRIC_CATALOG.length);
  });
});

describe("provenance + freshness (#155)", () => {
  it("ranks semantic layer above curated above raw", () => {
    expect(PATH_RANK.semantic_layer).toBeGreaterThan(PATH_RANK.curated_reference);
    expect(PATH_RANK.curated_reference).toBeGreaterThan(PATH_RANK.raw_data);
    expect(isFallbackPath("semantic_layer")).toBe(false);
    expect(isFallbackPath("curated_reference")).toBe(true);
    expect(isFallbackPath("raw_data")).toBe(true);
  });

  it("computes freshness, clamps future skew, treats unknown timestamps as stale", () => {
    const now = 1_000_000;
    expect(computeFreshness(now - 5000, now, 10_000)).toEqual({
      asOfMs: now - 5000,
      ageMs: 5000,
      stale: false,
    });
    expect(computeFreshness(now - 20_000, now, 10_000).stale).toBe(true);
    expect(computeFreshness(now + 5000, now, 10_000).ageMs).toBe(0); // future clamped
    expect(computeFreshness(null, now, 10_000)).toEqual({ asOfMs: null, ageMs: null, stale: true });
    // maxAge <= 0 ⇒ never stale on age
    expect(computeFreshness(now - 1_000_000, now, 0).stale).toBe(false);
  });

  it("formats age into short human strings", () => {
    expect(formatAge(null)).toBe("freshness unknown");
    expect(formatAge(30_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5m ago");
    expect(formatAge(3 * 3_600_000)).toBe("3h ago");
    expect(formatAge(2 * 86_400_000)).toBe("2d ago");
  });
});

describe("answer rendering (#155)", () => {
  it("renders values per unit", () => {
    expect(renderValue(72.34, "score_0_100")).toBe("72.3/100");
    expect(renderValue(6.55, "score_0_10")).toBe("6.6/10");
    expect(renderValue(0.1234, "rate_0_1")).toBe("12.3%");
    expect(renderValue(1999, "cents")).toBe("$19.99");
    expect(renderValue(150, "cents")).toBe("$1.50"); // keeps trailing zero (not $1.5)
    expect(renderValue(100, "cents")).toBe("$1.00");
    expect(renderValue(42.7, "count")).toBe("43");
    expect(renderValue(null, "score_0_100")).toBe("—");
  });

  it("a semantic-layer answer cites provenance + freshness and is NOT flagged a fallback", () => {
    const def = getMetric("growth.score")!;
    const now = 1_000_000;
    const ans = buildAnswer(def, { value: 72, asOfMs: now - 1000, path: "semantic_layer" }, now, 60_000);
    expect(ans.fallback).toBe(false);
    expect(ans.value).toBe(72);
    expect(ans.spoken).toContain("72/100");
    expect(ans.spoken).toContain("semantic layer (canonical)");
    expect(ans.spoken).toContain("made by robots, steered by humans.");
    expect(ans.spoken).not.toContain("fallback path");
  });

  it("a raw-data answer is flagged as a fallback and a stale one says so", () => {
    const def = getMetric("demand.visit_to_paid")!;
    const now = 1_000_000;
    const ans = buildAnswer(def, { value: 0.05, asOfMs: now - 999_999, path: "raw_data" }, now, 10_000);
    expect(ans.fallback).toBe(true);
    expect(ans.spoken).toContain("fallback path");
    expect(ans.spoken).toContain("stale");
    expect(ans.spoken).toContain("raw data (unverified)");
  });

  it("a null value says there is no governed number rather than inventing one", () => {
    const def = getMetric("venture.score")!;
    const now = 1_000_000;
    const ans = buildAnswer(def, { value: null, asOfMs: null, path: "semantic_layer" }, now, 60_000);
    expect(ans.value).toBeNull();
    expect(ans.spoken).toContain("No governed number");
  });
});
