import { describe, it, expect } from "vitest";
import {
  assertBillingProviderCredentials,
  BillingProviderCredentialError,
} from "../../src/billing/factory.js";
import { BillingModeMismatchError } from "../../src/billing/mode.js";
import type { BillingEnv } from "../../src/env.js";

/**
 * #1510 startup billing preflight. ADR-0421 added a fail-closed key/mode guard, but it fired only
 * per-request INSIDE the Stripe adapter — so a live key with `BILLING_MODE` unset (→ `test`) booted
 * cleanly and then 502-ed EVERY checkout (a silent revenue outage until a human QA'd it). This suite pins
 * the strict preflight that promotes that mismatch to a loud, actionable BOOT failure — behind a flag that
 * defaults OFF so existing deploys are byte-for-byte unchanged.
 */
function billingEnv(over: Partial<BillingEnv> = {}): BillingEnv {
  return { provider: "stripe", mode: "test", webhookToleranceSeconds: 300, ...over };
}

describe("assertBillingProviderCredentials — #1510 startup mode/key preflight", () => {
  it("is a no-op for the none provider (no key, any mode)", () => {
    expect(() =>
      assertBillingProviderCredentials(billingEnv({ provider: "none" }), {} as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("still throws BillingProviderCredentialError when stripe has no key (pre-existing guard)", () => {
    expect(() => assertBillingProviderCredentials(billingEnv(), {} as NodeJS.ProcessEnv)).toThrow(
      BillingProviderCredentialError,
    );
  });

  it("does NOT fail boot on a live-key/test-mode mismatch when the strict flag is OFF (default — unchanged)", () => {
    // This is exactly the #1510 prod config (live key + BILLING_MODE unset). With the flag off we preserve
    // today's behavior: boot succeeds (the mismatch still fails closed later, per-request). Default OFF.
    expect(() =>
      assertBillingProviderCredentials(billingEnv({ preflightStrict: false }), {
        STRIPE_SECRET_KEY: "sk_live_boot",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("FAILS boot loudly on a live-key/test-mode mismatch when the strict flag is ON (#1510 fix)", () => {
    expect(() =>
      assertBillingProviderCredentials(billingEnv({ mode: "test", preflightStrict: true }), {
        STRIPE_SECRET_KEY: "sk_live_boot",
      } as NodeJS.ProcessEnv),
    ).toThrow(BillingModeMismatchError);
  });

  it("FAILS boot on the inverse (test key + live mode) under the strict flag — no silent zero-revenue", () => {
    expect(() =>
      assertBillingProviderCredentials(billingEnv({ mode: "live", preflightStrict: true }), {
        STRIPE_SECRET_KEY: "sk_test_boot",
      } as NodeJS.ProcessEnv),
    ).toThrow(BillingModeMismatchError);
  });

  it("passes under the strict flag when the key matches the declared mode", () => {
    expect(() =>
      assertBillingProviderCredentials(billingEnv({ mode: "live", preflightStrict: true }), {
        STRIPE_SECRET_KEY: "sk_live_boot",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertBillingProviderCredentials(billingEnv({ mode: "test", preflightStrict: true }), {
        STRIPE_SECRET_KEY: "sk_test_boot",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("passes under the strict flag for an unclassifiable key (no false-positive boot failure)", () => {
    expect(() =>
      assertBillingProviderCredentials(billingEnv({ mode: "live", preflightStrict: true }), {
        STRIPE_SECRET_KEY: "rk_opaque_restricted_token",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("never leaks the key value in the boot failure message", () => {
    try {
      assertBillingProviderCredentials(billingEnv({ mode: "test", preflightStrict: true }), {
        STRIPE_SECRET_KEY: "sk_live_SUPERSECRETVALUE",
      } as NodeJS.ProcessEnv);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingModeMismatchError);
      expect((err as Error).message).not.toContain("SUPERSECRETVALUE");
    }
  });
});
