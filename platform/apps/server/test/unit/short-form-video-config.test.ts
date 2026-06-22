import { describe, it, expect } from "vitest";
import {
  resolveShortFormVideoConfig,
  SHORTFORM_VIDEO_DEFAULTS,
} from "../../src/short-form-video/config.js";

/**
 * The short-form video config (#740): env-only, default OFF. Drives every branch with a synthetic env so it
 * never reads the real `process.env`.
 */
describe("resolveShortFormVideoConfig (#740)", () => {
  it("defaults to OFF with sensible vertical short-form numbers when nothing is set", () => {
    const cfg = resolveShortFormVideoConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg).toEqual(SHORTFORM_VIDEO_DEFAULTS);
    expect(cfg.provider).toBe("fake");
    expect(cfg.aspectRatio).toBe("9:16");
  });

  it("enables on any truthy flag spelling and stays off otherwise", () => {
    for (const v of ["1", "true", "YES", "on"]) {
      expect(resolveShortFormVideoConfig({ SHORTFORM_VIDEO_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ["0", "false", "no", "", "off"]) {
      expect(resolveShortFormVideoConfig({ SHORTFORM_VIDEO_ENABLED: v }).enabled).toBe(false);
    }
  });

  it("reads numeric + aspect-ratio overrides, falling back on invalid input", () => {
    const cfg = resolveShortFormVideoConfig({
      SHORTFORM_VIDEO_MAX_DURATION_SECONDS: "30",
      SHORTFORM_VIDEO_MAX_SCENES: "4",
      SHORTFORM_VIDEO_ASPECT_RATIO: "1:1",
    });
    expect(cfg.maxDurationSeconds).toBe(30);
    expect(cfg.maxScenes).toBe(4);
    expect(cfg.aspectRatio).toBe("1:1");

    const bad = resolveShortFormVideoConfig({
      SHORTFORM_VIDEO_MAX_DURATION_SECONDS: "-5",
      SHORTFORM_VIDEO_MAX_SCENES: "abc",
      SHORTFORM_VIDEO_ASPECT_RATIO: "not-a-ratio",
    });
    expect(bad.maxDurationSeconds).toBe(SHORTFORM_VIDEO_DEFAULTS.maxDurationSeconds);
    expect(bad.maxScenes).toBe(SHORTFORM_VIDEO_DEFAULTS.maxScenes);
    expect(bad.aspectRatio).toBe(SHORTFORM_VIDEO_DEFAULTS.aspectRatio);
  });
});
