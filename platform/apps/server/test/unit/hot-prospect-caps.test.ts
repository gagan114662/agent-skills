import { describe, it, expect } from "vitest";
import {
  resolveHotProspectPolicy,
  DEFAULT_INTENT_RULES,
  HOT_PROSPECT_DEFAULTS,
} from "../../src/hot-prospect/caps.js";

const HOUR = 60 * 60 * 1000;

describe("resolveHotProspectPolicy — defaults", () => {
  it("is DEFAULT-OFF and inert with no env set", () => {
    const p = resolveHotProspectPolicy({});
    expect(p.enabled).toBe(false);
    expect(p.windowMs).toBe(HOT_PROSPECT_DEFAULTS.windowMs);
    expect(p.scoreThreshold).toBe(HOT_PROSPECT_DEFAULTS.scoreThreshold);
    expect(p.cooldownMs).toBe(HOT_PROSPECT_DEFAULTS.cooldownMs);
  });

  it("carries the governed intent model (not env-tunable)", () => {
    const p = resolveHotProspectPolicy({});
    expect(p.rules).toBe(DEFAULT_INTENT_RULES);
    expect(p.rules.some((r) => r.kind === "pricing_view" && r.burstThreshold === 3)).toBe(true);
  });
});

describe("resolveHotProspectPolicy — env overrides", () => {
  it("honors the master switch and operating envelope", () => {
    const p = resolveHotProspectPolicy({
      HOT_PROSPECT_ALERTING_ENABLED: "1",
      HOT_PROSPECT_WINDOW_HOURS: "12",
      HOT_PROSPECT_SCORE_THRESHOLD: "35",
      HOT_PROSPECT_COOLDOWN_HOURS: "6",
    });
    expect(p.enabled).toBe(true);
    expect(p.windowMs).toBe(12 * HOUR);
    expect(p.scoreThreshold).toBe(35);
    expect(p.cooldownMs).toBe(6 * HOUR);
  });

  it("parses assorted truthy/falsy flag spellings", () => {
    expect(resolveHotProspectPolicy({ HOT_PROSPECT_ALERTING_ENABLED: "on" }).enabled).toBe(true);
    expect(resolveHotProspectPolicy({ HOT_PROSPECT_ALERTING_ENABLED: "YES" }).enabled).toBe(true);
    expect(resolveHotProspectPolicy({ HOT_PROSPECT_ALERTING_ENABLED: "off" }).enabled).toBe(false);
    expect(resolveHotProspectPolicy({ HOT_PROSPECT_ALERTING_ENABLED: "garbage" }).enabled).toBe(false);
  });

  it("falls back to defaults on invalid numeric values", () => {
    const p = resolveHotProspectPolicy({
      HOT_PROSPECT_WINDOW_HOURS: "-4",
      HOT_PROSPECT_SCORE_THRESHOLD: "nope",
      HOT_PROSPECT_COOLDOWN_HOURS: "0",
    });
    expect(p.windowMs).toBe(HOT_PROSPECT_DEFAULTS.windowMs);
    expect(p.scoreThreshold).toBe(HOT_PROSPECT_DEFAULTS.scoreThreshold);
    expect(p.cooldownMs).toBe(HOT_PROSPECT_DEFAULTS.cooldownMs);
  });
});
