import { describe, it, expect } from "vitest";
import {
  buildProofScorecard,
  type ProofMetricReading,
} from "../../src/founder-console/proof-scorecard.js";
import { MARKETING_DEPARTMENTS } from "../../src/marketing/blueprint.js";

const DEPT_KEYS = MARKETING_DEPARTMENTS.map((d) => d.key);

describe("buildProofScorecard (#253 — the per-department proof scorecard)", () => {
  it("always emits one tile per marketing department, in canonical order", () => {
    const card = buildProofScorecard({});
    expect(card.total).toBe(MARKETING_DEPARTMENTS.length);
    expect(card.tiles.map((t) => t.department)).toEqual(DEPT_KEYS);
  });

  it("renders every department as 'not connected' when no readings are supplied — never a fake number", () => {
    const card = buildProofScorecard({});
    expect(card.connectedCount).toBe(0);
    for (const tile of card.tiles) {
      expect(tile.connection).toBe("not_connected");
      expect(tile.value).toBeNull();
      expect(tile.display).toBe("not connected");
      expect(tile.trend).toBe("none");
    }
  });

  it("renders a connected count tile with a value and the department's agent + title", () => {
    const reading: ProofMetricReading = {
      department: "content",
      connected: true,
      current: 7,
      prior: 4,
      unit: "count",
      metricLabel: "Articles live on the blog",
      source: "Published artifacts (#231)",
    };
    const tile = buildProofScorecard({ readings: [reading] }).tiles.find(
      (t) => t.department === "content",
    )!;
    expect(tile.connection).toBe("connected");
    expect(tile.agent).toBe("Quill");
    expect(tile.title).toBe("Content");
    expect(tile.value).toBe(7);
    expect(tile.display).toBe("7");
    expect(tile.trend).toBe("up");
    expect(tile.delta).toBe(3);
    expect(tile.improving).toBe(true);
    expect(tile.trendDetail).toBe("+3");
    expect(tile.source).toBe("Published artifacts (#231)");
  });

  it("formats currency values and deltas, and treats a falling CAC as an improvement (higherIsBetter:false)", () => {
    const reading: ProofMetricReading = {
      department: "ads",
      connected: true,
      current: 4200,
      prior: 5000,
      unit: "currency",
      metricLabel: "Blended CAC",
      higherIsBetter: false,
      source: "Acquisition receipts → CAC (#189)",
    };
    const tile = buildProofScorecard({ readings: [reading] }).tiles.find(
      (t) => t.department === "ads",
    )!;
    expect(tile.display).toBe("$42.00");
    expect(tile.trend).toBe("down");
    expect(tile.delta).toBe(-800);
    expect(tile.improving).toBe(true); // CAC fell — good
    expect(tile.trendDetail).toBe("−$8.00");
  });

  it("reports 'flat' with no improvement verdict when the value did not move", () => {
    const tile = buildProofScorecard({
      readings: [{ department: "email", connected: true, current: 10, prior: 10, unit: "count" }],
    }).tiles.find((t) => t.department === "email")!;
    expect(tile.trend).toBe("flat");
    expect(tile.delta).toBe(0);
    expect(tile.improving).toBeNull();
    expect(tile.trendDetail).toBe("no change");
  });

  it("reports trend 'none' when no prior window is supplied (a value without a comparison)", () => {
    const tile = buildProofScorecard({
      readings: [{ department: "social", connected: true, current: 5, unit: "count" }],
    }).tiles.find((t) => t.department === "social")!;
    expect(tile.connection).toBe("connected");
    expect(tile.value).toBe(5);
    expect(tile.trend).toBe("none");
    expect(tile.delta).toBeNull();
    expect(tile.trendDetail).toBe("—");
  });

  it("keeps a reading 'not connected' when connected:false, but surfaces its source + note (the WHY)", () => {
    const tile = buildProofScorecard({
      readings: [
        {
          department: "seo",
          connected: false,
          current: null,
          unit: "count",
          source: "Search Console not connected",
          note: "connect Google Search Console to prove indexed pages + rankings",
        },
      ],
    }).tiles.find((t) => t.department === "seo")!;
    expect(tile.connection).toBe("not_connected");
    expect(tile.value).toBeNull();
    expect(tile.display).toBe("not connected");
    expect(tile.source).toBe("Search Console not connected");
    expect(tile.note).toContain("Search Console");
  });

  it("never fabricates a number: connected:true with a null current still renders 'not connected'", () => {
    const tile = buildProofScorecard({
      readings: [{ department: "brand", connected: true, current: null, unit: "count" }],
    }).tiles.find((t) => t.department === "brand")!;
    expect(tile.connection).toBe("not_connected");
    expect(tile.value).toBeNull();
  });

  it("falls back to the department's default metric label when the reading omits one", () => {
    const card = buildProofScorecard({});
    const seo = card.tiles.find((t) => t.department === "seo")!;
    const analytics = card.tiles.find((t) => t.department === "analytics")!;
    expect(seo.metricLabel).toContain("keyword positions");
    expect(analytics.metricLabel).toContain("signups");
  });

  it("counts only connected tiles in connectedCount", () => {
    const card = buildProofScorecard({
      readings: [
        { department: "content", connected: true, current: 1, unit: "count" },
        { department: "ads", connected: true, current: 0, unit: "currency" },
        { department: "seo", connected: false, current: null, unit: "count" },
      ],
    });
    expect(card.connectedCount).toBe(2);
  });
});
