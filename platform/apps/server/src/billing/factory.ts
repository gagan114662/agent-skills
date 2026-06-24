import type { BillingEnv } from "../env.js";
import type { BillingProvider } from "./provider.js";
import { NoneBillingProvider } from "./none-provider.js";
import { StripeBillingProvider } from "./stripe-provider.js";

export class BillingProviderCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingProviderCredentialError";
  }
}

export function assertBillingProviderCredentials(
  env: BillingEnv,
  source: NodeJS.ProcessEnv = process.env,
): void {
  if (env.provider !== "stripe") return;
  if (!source.STRIPE_SECRET_KEY) {
    throw new BillingProviderCredentialError(
      "BILLING_PROVIDER=stripe requires STRIPE_SECRET_KEY at startup; set it or use BILLING_PROVIDER=none.",
    );
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
