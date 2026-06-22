import { describe, it, expect } from "vitest";
import {
  resolveRunReplayCaps,
  RUN_REPLAY_DEFAULTS,
  DEFAULT_MAX_INPUT_BYTES,
} from "../../src/run-replay/caps.js";

describe("resolveRunReplayCaps", () => {
  it("defaults OFF with the documented byte cap when the environment is empty", () => {
    const caps = resolveRunReplayCaps({});
    expect(caps).toEqual({ enabled: false, maxInputBytes: DEFAULT_MAX_INPUT_BYTES });
    expect(caps).toEqual(RUN_REPLAY_DEFAULTS);
  });

  it("parses boolean-ish enable flags case-insensitively", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(resolveRunReplayCaps({ RUN_REPLAY_ENABLED: raw }).enabled).toBe(true);
    }
    for (const raw of ["0", "false", "no", "off", "", "nope"]) {
      expect(resolveRunReplayCaps({ RUN_REPLAY_ENABLED: raw }).enabled).toBe(false);
    }
  });

  it("reads a positive integer byte cap", () => {
    expect(resolveRunReplayCaps({ RUN_REPLAY_MAX_INPUT_BYTES: "4096" }).maxInputBytes).toBe(4096);
  });

  it("falls back to the default for missing, non-numeric, zero, or negative values", () => {
    for (const bad of ["abc", "-1", "0", "NaN"]) {
      expect(resolveRunReplayCaps({ RUN_REPLAY_MAX_INPUT_BYTES: bad }).maxInputBytes).toBe(
        DEFAULT_MAX_INPUT_BYTES,
      );
    }
  });

  it("truncates a fractional byte cap to an integer", () => {
    expect(resolveRunReplayCaps({ RUN_REPLAY_MAX_INPUT_BYTES: "4096.9" }).maxInputBytes).toBe(4096);
  });
});
