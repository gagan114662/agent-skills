import type { BillingEnv } from "../env.js";
import type { BillingProvider } from "./provider.js";
import { NoneBillingProvider } from "./none-provider.js";
import { StripeBillingProvider } from "./stripe-provider.js";
import { assertKeyMatchesMode, diagnoseBillingConfig, stripeKeyMode } from "./mode.js";

export class BillingProviderCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingProviderCredentialError";
  }
}

/**
 * Startup billing preflight (#98 credentials + #1510 mode/key consistency). Runs at boot, before any
 * request. Two guards:
 *   - `stripe` with no `STRIPE_SECRET_KEY` → `BillingProviderCredentialError` (pre-existing, always on).
 *   - #1510: when `env.preflightStrict` is on, a key whose prefix mode contradicts the declared
 *     `BILLING_MODE` → `BillingModeMismatchError`, reusing ADR-0421's guard. This promotes the exact
 *     production incident (a `sk_live_…` key while `BILLING_MODE` was unset → `test`) from a silent
 *     per-request checkout 502 into a loud, actionable BOOT failure. Default OFF: byte-for-byte unchanged.
 * The key value is never logged or interpolated into any error (only its inferred, non-secret mode).
 */
export function assertBillingProviderCredentials(
  env: BillingEnv,
  source: NodeJS.ProcessEnv = process.env,
): void {
  if (env.provider !== "stripe") return;
  const key = source.STRIPE_SECRET_KEY ?? "";
  const diagnosis = diagnoseBillingConfig({
    provider: env.provider,
    mode: env.mode,
    keyMode: stripeKeyMode(key),
    hasKey: key.length > 0,
  });
  if (diagnosis === "missing_key") {
    throw new BillingProviderCredentialError(
      "BILLING_PROVIDER=stripe requires STRIPE_SECRET_KEY at startup; set it or use BILLING_PROVIDER=none.",
    );
  }
  // #1510: fail the boot loudly on a mode/key mismatch, but only when the owner has opted in (default OFF).
  if (env.preflightStrict === true && diagnosis === "mode_key_mismatch") {
    assertKeyMatchesMode(env.mode, key);
  }
}

/**
 * Select the billing backend from config (#98), mirroring `createDeployProvider` (#73) / `createRuntime`
 * (#25). `none` is the default so tests/CI/the demo make zero network calls and never spend; `stripe`
 * returns the real adapter (the `stripe` SDK is loaded lazily on first call, so selecting it here never
 * touches the package). A provider can be injected (tests pass a fake) — when omitted the env selects.
 */
export function createBillingProvider(
  env: BillingEnv,
  provider?: BillingProvider,
  source: NodeJS.ProcessEnv = process.env,
): BillingProvider {
  if (provider) return provider;
  assertBillingProviderCredentials(env, source);
  // #481: thread the declared go-live mode into the adapter so it can fail closed on a key/mode mismatch.
  if (env.provider === "stripe") return new StripeBillingProvider(env.mode);
  return new NoneBillingProvider();
}
