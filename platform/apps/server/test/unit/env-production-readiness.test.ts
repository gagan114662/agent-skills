import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";

const productionBase = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://prod.example/reload",
  REDIS_URL: "redis://prod.example:6379",
  RELOAD_PROFILE: "prod",
  DEPLOY_PROVIDER: "vercel",
  BILLING_PROVIDER: "stripe",
} satisfies NodeJS.ProcessEnv;

describe("loadEnv production readiness", () => {
  it("fails closed instead of using localhost data services in production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        RELOAD_PROFILE: "prod",
        DEPLOY_PROVIDER: "vercel",
        BILLING_PROVIDER: "stripe",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL must be set in production/);

    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        RELOAD_PROFILE: "prod",
        DATABASE_URL: "postgres://prod.example/reload",
        DEPLOY_PROVIDER: "vercel",
        BILLING_PROVIDER: "stripe",
      } as NodeJS.ProcessEnv),
    ).toThrow(/REDIS_URL must be set in production/);
  });

  it("allows the local data-service fallback only behind an explicit production flag", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      RELOAD_PROFILE: "prod",
      DEPLOY_PROVIDER: "vercel",
      BILLING_PROVIDER: "stripe",
      RELOAD_ALLOW_DEV_DATA_SERVICES_IN_PROD: "1",
    } as NodeJS.ProcessEnv);

    expect(env.databaseUrl).toBe("postgres://reload:reload@localhost:5433/reload");
    expect(env.redisUrl).toBe("redis://localhost:6379");
  });

  it("blocks demo harness, dryrun deploy, and billing-none defaults in production", () => {
    expect(() =>
      loadEnv({
        ...productionBase,
        AGENT_HARNESS: "demo",
      } as NodeJS.ProcessEnv),
    ).toThrow(/AGENT_HARNESS=demo is not allowed in production/);

    expect(() =>
      loadEnv({
        ...productionBase,
        DEPLOY_PROVIDER: "dryrun",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DEPLOY_PROVIDER=vercel is required in production/);

    expect(() =>
      loadEnv({
        ...productionBase,
        BILLING_PROVIDER: "none",
      } as NodeJS.ProcessEnv),
    ).toThrow(/BILLING_PROVIDER=stripe is required in production/);
  });

  it("keeps explicit real production posture valid", () => {
    const env = loadEnv(productionBase as NodeJS.ProcessEnv);

    expect(env.databaseUrl).toBe("postgres://prod.example/reload");
    expect(env.redisUrl).toBe("redis://prod.example:6379");
    // #1568: the prod posture executes on the Claude provider by default.
    expect(env.agent.harness).toBe("claude-code");
    expect(env.deploy.provider).toBe("vercel");
    expect(env.billing.provider).toBe("stripe");
  });
});
