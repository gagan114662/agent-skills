import { describe, it, expect } from "vitest";
import {
  assertKeyMatchesMode,
  billingStatus,
  BillingModeMismatchError,
  diagnoseBillingConfig,
  stripeKeyMode,
} from "../../src/billing/mode.js";

/**
 * #481 go-live: test/live mode separation + key validation. The pure half — infer a Stripe key's mode
 * from its prefix and FAIL CLOSED when the declared `BILLING_MODE` doesn't match the key actually
 * supplied. This is the safety rail that stops two opposite mistakes: charging real cards from a
 * test/staging env (live key while `BILLING_MODE=test`) and silently taking NO real money in production
 * (test key while `BILLING_MODE=live`). SDK-free so it runs in the no-network unit job.
 */
describe("billing mode (#481 — test/live key validation)", () => {
  describe("stripeKeyMode", () => {
    it("reads live from sk_live_ / rk_live_ / pk_live_ prefixes", () => {
      expect(stripeKeyMode("sk_live_abc123")).toBe("live");
      expect(stripeKeyMode("rk_live_abc123")).toBe("live");
      expect(stripeKeyMode("pk_live_abc123")).toBe("live");
    });

    it("reads test from sk_test_ / rk_test_ / pk_test_ prefixes", () => {
      expect(stripeKeyMode("sk_test_abc123")).toBe("test");
      expect(stripeKeyMode("rk_test_abc123")).toBe("test");
      expect(stripeKeyMode("pk_test_abc123")).toBe("test");
    });

    it("returns unknown for non-key strings (webhook secret, empty, garbage)", () => {
      expect(stripeKeyMode("whsec_abc")).toBe("unknown");
      expect(stripeKeyMode("")).toBe("unknown");
      expect(stripeKeyMode("nonsense")).toBe("unknown");
    });
  });

  describe("assertKeyMatchesMode", () => {
    it("passes when a live key is used in live mode", () => {
      expect(() => assertKeyMatchesMode("live", "sk_live_abc")).not.toThrow();
    });

    it("passes when a test key is used in test mode", () => {
      expect(() => assertKeyMatchesMode("test", "sk_test_abc")).not.toThrow();
    });

    it("THROWS when a test key is supplied in live mode (would silently take no real money)", () => {
      expect(() => assertKeyMatchesMode("live", "sk_test_abc")).toThrow(BillingModeMismatchError);
    });

    it("THROWS when a live key is supplied in test mode (would charge real cards)", () => {
      expect(() => assertKeyMatchesMode("test", "sk_live_abc")).toThrow(BillingModeMismatchError);
    });

    it("never leaks the key value in the mismatch error message", () => {
      try {
        assertKeyMatchesMode("test", "sk_live_SUPERSECRETVALUE");
        throw new Error("expected a throw");
      } catch (err) {
        expect(err).toBeInstanceOf(BillingModeMismatchError);
        expect((err as Error).message).not.toContain("SUPERSECRETVALUE");
      }
    });

    it("does not throw for an unclassifiable key (can't determine — SDK validates it)", () => {
      // A custom/unrecognised prefix can't be classified; don't false-positive — Stripe rejects a bad key.
      expect(() => assertKeyMatchesMode("live", "custom_opaque_key")).not.toThrow();
      expect(() => assertKeyMatchesMode("live", "")).not.toThrow();
    });
  });

  describe("diagnoseBillingConfig (#1510 — startup config classifier)", () => {
    it("is ok for the none provider regardless of mode/key (can never charge)", () => {
      expect(
        diagnoseBillingConfig({ provider: "none", mode: "test", keyMode: "unknown", hasKey: false }),
      ).toBe("ok");
      expect(
        diagnoseBillingConfig({ provider: "none", mode: "live", keyMode: "live", hasKey: true }),
      ).toBe("ok");
    });

    it("flags missing_key when stripe is selected but no key is present", () => {
      expect(
        diagnoseBillingConfig({ provider: "stripe", mode: "test", keyMode: "unknown", hasKey: false }),
      ).toBe("missing_key");
    });

    it("flags mode_key_mismatch for a LIVE key while mode is test (the #1510 revenue outage)", () => {
      // BILLING_MODE unset → parsed as `test`; a real sk_live_ key present → every checkout would 502.
      expect(
        diagnoseBillingConfig({ provider: "stripe", mode: "test", keyMode: "live", hasKey: true }),
      ).toBe("mode_key_mismatch");
    });

    it("flags mode_key_mismatch for a TEST key while mode is live (silent zero real revenue)", () => {
      expect(
        diagnoseBillingConfig({ provider: "stripe", mode: "live", keyMode: "test", hasKey: true }),
      ).toBe("mode_key_mismatch");
    });

    it("is ok when the key's mode matches the declared mode", () => {
      expect(
        diagnoseBillingConfig({ provider: "stripe", mode: "live", keyMode: "live", hasKey: true }),
      ).toBe("ok");
      expect(
        diagnoseBillingConfig({ provider: "stripe", mode: "test", keyMode: "test", hasKey: true }),
      ).toBe("ok");
    });

    it("is ok for an unclassifiable key (opaque/restricted prefix) — no false positive", () => {
      // Stripe itself rejects an invalid key; we don't manufacture a boot failure from a prefix we can't read.
      expect(
        diagnoseBillingConfig({ provider: "stripe", mode: "live", keyMode: "unknown", hasKey: true }),
      ).toBe("ok");
    });
  });

  describe("billingStatus", () => {
    it("is live ONLY when the stripe provider runs in live mode", () => {
      expect(billingStatus("stripe", "live")).toEqual({ provider: "stripe", mode: "live", live: true });
    });

    it("is not live for stripe in test mode", () => {
      expect(billingStatus("stripe", "test")).toEqual({ provider: "stripe", mode: "test", live: false });
    });

    it("is never live for the none provider, even if mode says live", () => {
      expect(billingStatus("none", "live")).toEqual({ provider: "none", mode: "live", live: false });
      expect(billingStatus("none", "test")).toEqual({ provider: "none", mode: "test", live: false });
    });
  });
});
