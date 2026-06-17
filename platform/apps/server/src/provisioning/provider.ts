/**
 * The central credential seam (issue #267, ADR-0267). The ONLY read-back path for a centrally-held provider
 * key. A {@link CentralCredentialResolver} returns the SEALED-then-opened env map for one provider's
 * credential — read from the OWNER workspace vault under `central:<provider>` (#192), never a per-customer
 * paste. It is consumed ONLY by the {@link ProvisioningService} server-side (like `BillingSecretsResolver`
 * for Stripe), so a central key is NEVER merged into an agent runtime's env passthrough and the customer
 * never sees it.
 *
 * Default-OFF by contract: an implementation that has no central credential connected returns `{}`, so the
 * per-department adapter falls back to its free mock path gracefully (no throw, no leak).
 */
export interface CentralCredentialResolver {
  /** Resolve a provider's central credential env map (`{}` when not connected). NEVER user-facing. */
  resolveCentral(provider: string): Promise<Record<string, string>>;
}

/** A resolver that holds nothing — the safe default for an un-provisioned deployment / the unit job. */
export class EmptyCentralCredentialResolver implements CentralCredentialResolver {
  resolveCentral(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }
}

/** A fixed-map resolver for tests/the demo — keyed by provider id. Never reads a real vault. */
export class StaticCentralCredentialResolver implements CentralCredentialResolver {
  constructor(private readonly byProvider: Record<string, Record<string, string>>) {}
  resolveCentral(provider: string): Promise<Record<string, string>> {
    return Promise.resolve({ ...(this.byProvider[provider] ?? {}) });
  }
}
