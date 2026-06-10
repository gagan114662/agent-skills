import { describe, it, expect } from "vitest";
import { PROFILES, DEFAULT_PROFILE, parseProfile, profilePreset } from "../../src/runtime/posture.js";
import { loadEnv } from "../../src/env.js";

describe("posture profiles (#69 — dev=local/demo, prod=sandbox/claude-code)", () => {
  it("defines the dev and prod presets", () => {
    expect(PROFILES.dev).toEqual({ runtime: "local", harness: "demo" });
    expect(PROFILES.prod).toEqual({ runtime: "sandbox", harness: "claude-code" });
  });

  it("defaults to dev for unset/unknown values (CI-safe)", () => {
    expect(DEFAULT_PROFILE).toBe("dev");
    expect(parseProfile(undefined)).toBe("dev");
    expect(parseProfile("nope")).toBe("dev");
    expect(parseProfile("prod")).toBe("prod");
    expect(profilePreset(parseProfile(undefined))).toEqual(PROFILES.dev);
  });
});

describe("loadEnv profile wiring (#69 — explicit env > profile preset > built-in default)", () => {
  it("with nothing set resolves to local/demo (unchanged default)", () => {
    const env = loadEnv({}).agent;
    expect(env.profile).toBe("dev");
    expect(env.runtime).toBe("local");
    expect(env.harness).toBe("demo");
  });

  it("RELOAD_PROFILE=prod flips runtime + harness in one switch", () => {
    const env = loadEnv({ RELOAD_PROFILE: "prod" }).agent;
    expect(env.profile).toBe("prod");
    expect(env.runtime).toBe("sandbox");
    expect(env.harness).toBe("claude-code");
  });

  it("an explicit AGENT_RUNTIME / AGENT_HARNESS overrides the profile preset", () => {
    const env = loadEnv({
      RELOAD_PROFILE: "prod",
      AGENT_RUNTIME: "local",
      AGENT_HARNESS: "demo",
    }).agent;
    expect(env.profile).toBe("prod"); // reported as selected…
    expect(env.runtime).toBe("local"); // …but the explicit override wins
    expect(env.harness).toBe("demo");
  });
});
