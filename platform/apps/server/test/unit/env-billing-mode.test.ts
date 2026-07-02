import { describe, it, expect } from "vitest";
import { loadEnv } from "../../src/env.js";

/**
 * #481 go-live: `BILLING_MODE` declares test vs live intent, defaulting to `test` so no env ever takes
 * real money by accident. Only the exact string `live` flips it — anything else stays `test` (fail safe).
 */
describe("loadEnv — billing go-live mode (#481)", () => {
  it("defaults billing.mode to test when BILLING_MODE is unset", () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.billing.mode).toBe("test");
  });

  it("flips to live only for the exact string 'live'", () => {
    expect(loadEnv({ BILLING_MODE: "live" } as NodeJS.ProcessEnv).billing.mode).toBe("live");
  });

  it("stays test for any other value (typo, uppercase, garbage) — fail safe", () => {
    expect(loadEnv({ BILLING_MODE: "LIVE" } as NodeJS.ProcessEnv).billing.mode).toBe("test");
    expect(loadEnv({ BILLING_MODE: "production" } as NodeJS.ProcessEnv).billing.mode).toBe("test");
    expect(loadEnv({ BILLING_MODE: "" } as NodeJS.ProcessEnv).billing.mode).toBe("test");
  });

  // #1510: the strict startup preflight is opt-in and defaults OFF so existing deploys are unchanged.
  it("defaults billing.preflightStrict to false when BILLING_PREFLIGHT_STRICT is unset", () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).billing.preflightStrict).toBe(false);
  });

  it("enables the strict preflight only for the exact strings 'true' or '1'", () => {
    expect(loadEnv({ BILLING_PREFLIGHT_STRICT: "true" } as NodeJS.ProcessEnv).billing.preflightStrict).toBe(true);
    expect(loadEnv({ BILLING_PREFLIGHT_STRICT: "1" } as NodeJS.ProcessEnv).billing.preflightStrict).toBe(true);
  });

  it("stays OFF for any other value (fail safe — never auto-enables a boot gate)", () => {
    expect(loadEnv({ BILLING_PREFLIGHT_STRICT: "yes" } as NodeJS.ProcessEnv).billing.preflightStrict).toBe(false);
    expect(loadEnv({ BILLING_PREFLIGHT_STRICT: "TRUE" } as NodeJS.ProcessEnv).billing.preflightStrict).toBe(false);
    expect(loadEnv({ BILLING_PREFLIGHT_STRICT: "" } as NodeJS.ProcessEnv).billing.preflightStrict).toBe(false);
  });
});
