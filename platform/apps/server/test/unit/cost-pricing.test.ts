import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  DEFAULT_PRICING,
  estimateCostMicros,
  formatUsd,
  normalizeModelId,
  resolveModelPricing,
} from "../../src/observability/cost/pricing.js";

afterEach(() => {
  delete process.env.OBSERVABILITY_COST_PRICING_JSON;
});

describe("normalizeModelId", () => {
  it("strips harness, provider, region, and snapshot decorations to a canonical id", () => {
    expect(normalizeModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(normalizeModelId("Claude-Opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelId("us.anthropic.claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelId("anthropic.claude-sonnet-4-6-v2:0")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
    expect(normalizeModelId("claude-opus-4-6-fast")).toBe("claude-opus-4-6");
  });

  it("returns empty string for missing input", () => {
    expect(normalizeModelId(null)).toBe("");
    expect(normalizeModelId(undefined)).toBe("");
    expect(normalizeModelId("")).toBe("");
  });
});

describe("resolveModelPricing", () => {
  it("matches known models exactly", () => {
    const r = resolveModelPricing("claude-opus-4-8");
    expect(r.match).toBe("exact");
    expect(r.pricing).toEqual(DEFAULT_PRICING["claude-opus-4-8"]);
  });

  it("falls back to family rates for an unknown version of a known family", () => {
    const r = resolveModelPricing("claude-opus-9-9");
    expect(r.match).toBe("family");
    expect(r.pricing.inputPerMTokUsd).toBe(5);
    expect(r.pricing.outputPerMTokUsd).toBe(25);
  });

  it("falls back to a conservative default for a totally unknown model", () => {
    const r = resolveModelPricing("some-other-llm");
    expect(r.match).toBe("default");
    expect(r.pricing.inputPerMTokUsd).toBe(5);
  });
});

describe("estimateCostMicros", () => {
  it("prices input and output tokens (USD/MTok == micros/token)", () => {
    // Opus 4.8: $5/1M input, $25/1M output. 1M input + 1M output = $5 + $25 = $30 = 30,000,000 micros.
    expect(estimateCostMicros("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      30_000_000,
    );
    // 1000 input tokens on Opus = 5 micros/token * 1000 = 5000 micros = $0.005.
    expect(estimateCostMicros("claude-opus-4-8", { inputTokens: 1000 })).toBe(5000);
  });

  it("prices cache reads and writes as multiples of the input rate", () => {
    const input = DEFAULT_PRICING["claude-opus-4-8"]!.inputPerMTokUsd;
    const reads = estimateCostMicros("claude-opus-4-8", { cacheReadTokens: 1_000_000 });
    const writes = estimateCostMicros("claude-opus-4-8", { cacheWriteTokens: 1_000_000 });
    expect(reads).toBe(Math.round(1_000_000 * input * CACHE_READ_MULTIPLIER));
    expect(writes).toBe(Math.round(1_000_000 * input * CACHE_WRITE_MULTIPLIER));
  });

  it("treats missing/negative usage as zero", () => {
    expect(estimateCostMicros("claude-opus-4-8", {})).toBe(0);
    expect(estimateCostMicros("claude-opus-4-8", { inputTokens: -100, outputTokens: null })).toBe(0);
  });

  it("returns an integer", () => {
    const micros = estimateCostMicros("claude-haiku-3-5", { inputTokens: 333, outputTokens: 777 });
    expect(Number.isInteger(micros)).toBe(true);
  });
});

describe("OBSERVABILITY_COST_PRICING_JSON override", () => {
  it("overrides built-in rates and normalizes override keys", () => {
    process.env.OBSERVABILITY_COST_PRICING_JSON = JSON.stringify({
      "claude-opus-4-8[1m]": { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    });
    const r = resolveModelPricing("claude-opus-4-8");
    expect(r.match).toBe("exact");
    expect(r.pricing).toEqual({ inputPerMTokUsd: 1, outputPerMTokUsd: 2 });
  });

  it("ignores malformed JSON without throwing", () => {
    process.env.OBSERVABILITY_COST_PRICING_JSON = "{not valid";
    expect(resolveModelPricing("claude-opus-4-8").pricing).toEqual(DEFAULT_PRICING["claude-opus-4-8"]);
  });

  it("ignores invalid override entries", () => {
    process.env.OBSERVABILITY_COST_PRICING_JSON = JSON.stringify({
      "claude-opus-4-8": { inputPerMTokUsd: "free", outputPerMTokUsd: -5 },
    });
    expect(resolveModelPricing("claude-opus-4-8").pricing).toEqual(DEFAULT_PRICING["claude-opus-4-8"]);
  });
});

describe("formatUsd", () => {
  it("renders micro-dollars as a USD string", () => {
    expect(formatUsd(5000)).toBe("$0.005000");
    expect(formatUsd(30_000_000, 2)).toBe("$30.00");
    expect(formatUsd(0)).toBe("$0.000000");
  });
});
