import { describe, it, expect } from "vitest";
import {
  resolveRunRecoveryCaps,
  resolveInstanceId,
  RUN_RECOVERY_DEFAULTS,
  DEFAULT_MAX_RESUME_ATTEMPTS,
} from "../../src/run-recovery/caps.js";

describe("resolveRunRecoveryCaps", () => {
  it("defaults OFF with the documented budget when the environment is empty", () => {
    const caps = resolveRunRecoveryCaps({});
    expect(caps).toEqual({ enabled: false, maxResumeAttempts: DEFAULT_MAX_RESUME_ATTEMPTS });
    expect(caps).toEqual(RUN_RECOVERY_DEFAULTS);
  });

  it("parses boolean-ish enable flags case-insensitively", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(resolveRunRecoveryCaps({ RUN_RECOVERY_ENABLED: raw }).enabled).toBe(true);
    }
    for (const raw of ["0", "false", "no", "off", "", "nope"]) {
      expect(resolveRunRecoveryCaps({ RUN_RECOVERY_ENABLED: raw }).enabled).toBe(false);
    }
  });

  it("reads a non-negative integer resume budget", () => {
    expect(resolveRunRecoveryCaps({ RUN_RECOVERY_MAX_RESUME_ATTEMPTS: "5" }).maxResumeAttempts).toBe(5);
    // zero is valid: it means "never resume — always fail an orphan"
    expect(resolveRunRecoveryCaps({ RUN_RECOVERY_MAX_RESUME_ATTEMPTS: "0" }).maxResumeAttempts).toBe(0);
  });

  it("falls back to the default for missing, non-numeric, or negative values", () => {
    for (const bad of ["abc", "-1", "NaN"]) {
      expect(resolveRunRecoveryCaps({ RUN_RECOVERY_MAX_RESUME_ATTEMPTS: bad }).maxResumeAttempts).toBe(
        DEFAULT_MAX_RESUME_ATTEMPTS,
      );
    }
  });

  it("truncates a fractional budget to an integer", () => {
    expect(resolveRunRecoveryCaps({ RUN_RECOVERY_MAX_RESUME_ATTEMPTS: "3.9" }).maxResumeAttempts).toBe(3);
  });
});

describe("resolveInstanceId", () => {
  it("honors an explicit RUN_RECOVERY_INSTANCE_ID", () => {
    expect(resolveInstanceId({ RUN_RECOVERY_INSTANCE_ID: "pod-7" })).toBe("pod-7");
    expect(resolveInstanceId({ RUN_RECOVERY_INSTANCE_ID: "  pod-7  " })).toBe("pod-7");
  });

  it("mints a fresh, unique id per boot when none is supplied", () => {
    const a = resolveInstanceId({});
    const b = resolveInstanceId({});
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("treats a blank override as unset and mints a uuid", () => {
    expect(resolveInstanceId({ RUN_RECOVERY_INSTANCE_ID: "   " })).toMatch(/^[0-9a-f-]{36}$/);
  });
});
