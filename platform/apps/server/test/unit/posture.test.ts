import { describe, it, expect } from "vitest";
import { PROFILES, DEFAULT_PROFILE, parseProfile, profilePreset } from "../../src/runtime/posture.js";
import { loadEnv } from "../../src/env.js";

describe("posture profiles (#69/#1270/#1568 — dev=local/demo, prod=sandbox/<provider>)", () => {
  it("defines the dev and prod presets (prod follows the Claude default provider)", () => {
    expect(PROFILES.dev).toEqual({ runtime: "local", harness: "demo" });
    expect(PROFILES.prod).toEqual({ runtime: "sandbox", harness: "claude-code" });
  });

  it("the prod preset harness is provider-driven (#1568)", () => {
    expect(profilePreset("prod")).toEqual({ runtime: "sandbox", harness: "claude-code" });
    expect(profilePreset("prod", "claude")).toEqual({ runtime: "sandbox", harness: "claude-code" });
    expect(profilePreset("prod", "codex")).toEqual({ runtime: "sandbox", harness: "codex" });
    // dev ignores the provider — it stays demo (no model spend in CI).
    expect(profilePreset("dev", "codex")).toEqual({ runtime: "local", harness: "demo" });
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
    expect(env.provider).toBe("claude");
    expect(env.runtime).toBe("local");
    expect(env.harness).toBe("demo");
  });

  it("RELOAD_PROFILE=prod flips runtime + harness in one switch (Claude default, #1568)", () => {
    const env = loadEnv({
      RELOAD_PROFILE: "prod",
      DATABASE_URL: "postgres://prod.example/reload",
      REDIS_URL: "redis://prod.example:6379",
      DEPLOY_PROVIDER: "vercel",
      BILLING_PROVIDER: "stripe",
    } as NodeJS.ProcessEnv).agent;
    expect(env.profile).toBe("prod");
    expect(env.provider).toBe("claude");
    expect(env.runtime).toBe("sandbox");
    expect(env.harness).toBe("claude-code");
  });

  it("AGENT_RUNTIME_PROVIDER=codex restores the legacy Codex prod posture (#1568)", () => {
    const env = loadEnv({
      RELOAD_PROFILE: "prod",
      AGENT_RUNTIME_PROVIDER: "codex",
      DATABASE_URL: "postgres://prod.example/reload",
      REDIS_URL: "redis://prod.example:6379",
      DEPLOY_PROVIDER: "vercel",
      BILLING_PROVIDER: "stripe",
    } as NodeJS.ProcessEnv).agent;
    expect(env.profile).toBe("prod");
    expect(env.provider).toBe("codex");
    expect(env.runtime).toBe("sandbox");
    expect(env.harness).toBe("codex");
  });

  it("an explicit AGENT_RUNTIME / AGENT_HARNESS overrides the profile preset", () => {
    const env = loadEnv({
      RELOAD_PROFILE: "prod",
      DATABASE_URL: "postgres://prod.example/reload",
      REDIS_URL: "redis://prod.example:6379",
      DEPLOY_PROVIDER: "vercel",
      BILLING_PROVIDER: "stripe",
      AGENT_RUNTIME: "local",
      AGENT_HARNESS: "demo",
      RELOAD_ALLOW_DEMO_HARNESS_IN_PROD: "1",
    }).agent;
    expect(env.profile).toBe("prod"); // reported as selected…
    expect(env.runtime).toBe("local"); // …but the explicit override wins
    expect(env.harness).toBe("demo");
  });
});
