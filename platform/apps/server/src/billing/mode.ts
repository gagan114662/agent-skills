/**
 * Test/live mode separation for the go-live billing path (issue #481). **Pure** and SDK-free (string
 * prefixes only) so it runs in the no-network unit job and is the single source of truth for "are we
 * about to move REAL money?". It sits alongside the structural inbound-only rail in ./safety.ts: that one
 * stops money moving OUT; this one stops the WRONG money moving in — a live key in a test/staging env
 * (accidental real charges) or a test key in production (silently zero real revenue).
 *
 * `BILLING_PROVIDER` chooses the backend; `BILLING_MODE` declares intent (test|live). Going live is the
 * owner's explicit, three-part flip — `BILLING_PROVIDER=stripe` + `BILLING_MODE=live` + a real `sk_live_…`
 * key — and any disagreement between the declared mode and the key actually supplied FAILS CLOSED.
 */

/** Declared billing intent. Default `test` everywhere — going live is an explicit owner action. */
export type BillingMode = "test" | "live";

/** What a Stripe credential's prefix says about its mode (or `unknown` when it isn't a mode-bearing key). */
export type KeyMode = BillingMode | "unknown";

/**
 * Infer a Stripe key's mode from its prefix. Stripe encodes the mode in secret (`sk_`), restricted
 * (`rk_`), and publishable (`pk_`) keys as `…_live_` / `…_test_`. Anything else (a webhook secret
 * `whsec_…`, an empty string, an opaque custom token) is `unknown` — we can't and don't guess.
 */
export function stripeKeyMode(key: string): KeyMode {
  if (/^[srp]k_live_/.test(key)) return "live";
  if (/^[srp]k_test_/.test(key)) return "test";
  return "unknown";
}

/** Thrown when the declared `BILLING_MODE` contradicts the Stripe key actually supplied. */
export class BillingModeMismatchError extends Error {
  constructor(declared: BillingMode, keyMode: BillingMode) {
    // NEVER interpolate the key itself — only its (non-secret) inferred mode.
    super(
      `BILLING_MODE=${declared} but the supplied Stripe key is a ${keyMode}-mode key. Refusing to run: ` +
        `a ${keyMode} key in ${declared} mode would ${
          declared === "live" ? "silently take no real money" : "charge real cards"
        }. Set a ${declared}-mode key, or change BILLING_MODE.`,
    );
    this.name = "BillingModeMismatchError";
  }
}

/**
 * Fail closed if the key's inferred mode disagrees with the declared `BILLING_MODE`. An `unknown` key
 * (custom/restricted prefix we can't classify, or none yet) is allowed through — Stripe itself rejects an
 * invalid key, and we don't manufacture false positives. The key value is never logged or thrown.
 */
export function assertKeyMatchesMode(declared: BillingMode, key: string): void {
  const keyMode = stripeKeyMode(key);
  if (keyMode === "unknown") return;
  if (keyMode !== declared) throw new BillingModeMismatchError(declared, keyMode);
}

/**
 * Startup billing-config classification (#1510). Pure and SDK-free — the single source of truth a boot
 * preflight consults BEFORE any request reaches the Stripe adapter. ADR-0421's key/mode guard only ran
 * *per-request* inside the adapter, so a live key with `BILLING_MODE` unset (→ `test`) booted cleanly and
 * then failed EVERY checkout with a 502 — a silent revenue outage. This classifier lets the preflight catch
 * the same disagreement at boot.
 */
export type BillingConfigDiagnosis = "ok" | "missing_key" | "mode_key_mismatch";

/** The (non-secret) inputs the config classifier reasons over — never the key value itself. */
export interface BillingConfigProbe {
  /** The configured backend. Only `stripe` can move money; anything else is inert. */
  provider: string;
  /** The declared `BILLING_MODE`. */
  mode: BillingMode;
  /** The mode inferred from the supplied key via {@link stripeKeyMode}; `unknown` if absent/opaque. */
  keyMode: KeyMode;
  /** Whether a `STRIPE_SECRET_KEY` is present at all. */
  hasKey: boolean;
}

/**
 * Classify a billing configuration. `none` provider is always `ok` (it can never charge). For `stripe`:
 * no key → `missing_key`; a mode-bearing key whose mode contradicts the declared mode → `mode_key_mismatch`
 * (the #1510 case); an unclassifiable key → `ok` (Stripe rejects a bad key itself — we never manufacture a
 * false-positive boot failure). Reasons over prefixes only; the key value is neither read nor returned.
 */
export function diagnoseBillingConfig(probe: BillingConfigProbe): BillingConfigDiagnosis {
  if (probe.provider !== "stripe") return "ok";
  if (!probe.hasKey) return "missing_key";
  if (probe.keyMode !== "unknown" && probe.keyMode !== probe.mode) return "mode_key_mismatch";
  return "ok";
}

/** Read-only go-live snapshot surfaced to the UI so the "test mode" banner reflects reality. */
export interface BillingStatus {
  /** The configured backend (`none` | `stripe`). */
  provider: "none" | "stripe";
  /** The declared mode (`test` | `live`). */
  mode: BillingMode;
  /** True iff REAL money can be charged right now: the `stripe` backend AND `live` mode. */
  live: boolean;
}

/**
 * Derive the go-live status. `live` is true ONLY for the real `stripe` backend in `live` mode — the
 * no-network `none` provider can never charge, regardless of the declared mode.
 */
export function billingStatus(provider: string, mode: BillingMode): BillingStatus {
  const normalized = provider === "stripe" ? "stripe" : "none";
  return { provider: normalized, mode, live: normalized === "stripe" && mode === "live" };
}
