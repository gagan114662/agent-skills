import { describe, expect, it } from "vitest";
import { createBillingProvider } from "../../src/billing/factory.js";
import { createDeployProvider } from "../../src/deploy/factory.js";

describe("provider credential preflight (#1004)", () => {
  it("fails fast when Stripe billing is selected without STRIPE_SECRET_KEY", () => {
    expect(() =>
      createBillingProvider(
        { provider: "stripe", mode: "test", webhookToleranceSeconds: 300 },
        undefined,
        {},
      ),
    ).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("fails fast when Vercel deploys are selected without VERCEL_TOKEN", () => {
    expect(() =>
      createDeployProvider({ provider: "vercel", monitorIntervalMs: 0 }, undefined, {}),
    ).toThrow(/VERCEL_TOKEN/);
  });

  it("does not require real-provider credentials for dryrun providers", () => {
    expect(createBillingProvider({ provider: "none", mode: "test", webhookToleranceSeconds: 300 }, undefined, {}).kind).toBe(
      "none",
    );
    expect(createDeployProvider({ provider: "dryrun", monitorIntervalMs: 0 }, undefined, {}).kind).toBe(
      "dryrun",
    );
  });

  it("selects real providers when their startup credentials are present", () => {
    expect(
      createBillingProvider(
        { provider: "stripe", mode: "test", webhookToleranceSeconds: 300 },
        undefined,
        { STRIPE_SECRET_KEY: "sk_test_boot" },
      ).kind,
    ).toBe("stripe");
    expect(
      createDeployProvider(
        { provider: "vercel", monitorIntervalMs: 0 },
        undefined,
        { VERCEL_TOKEN: "vercel_boot" },
      ).kind,
    ).toBe("vercel");
  });
});
