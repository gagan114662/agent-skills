import type { BillingEnv } from "../env.js";
import type { BillingProvider } from "./provider.js";
import { NoneBillingProvider } from "./none-provider.js";
import { StripeBillingProvider } from "./stripe-provider.js";

/**
 * Select the billing backend from config (#98), mirroring `createDeployProvider` (#73) / `createRuntime`
 * (#25). `none` is the default so tests/CI/the demo make zero network calls and never spend; `stripe`
 * returns the real adapter (the `stripe` SDK is loaded lazily on first call, so selecting it here never
 * touches the package). A provider can be injected (tests pass a fake) — when omitted the env selects.
 */
export function createBillingProvider(env: BillingEnv, provider?: BillingProvider): BillingProvider {
  if (provider) return provider;
  if (env.provider === "stripe") return new StripeBillingProvider();
  return new NoneBillingProvider();
}
