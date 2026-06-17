/**
 * Analytics read providers (issue #270).
 *
 * The read seam {@link AnalyticsProvider} has one honest default and two live stubs:
 *
 *  - {@link DryRunAnalyticsProvider} (`dryrun`, the default) reads NOTHING — it returns `null`, never a
 *    zero-filled reading. So an un-configured workspace's analytics tile stays "not connected / awaiting
 *    first reading" instead of overclaiming traffic that was never measured (premortem #200 §2).
 *  - {@link Ga4AnalyticsProvider} / {@link PlausibleAnalyticsProvider} are the live shapes. They read the
 *    vendor credential through an injected resolver (the central #267 vault / a per-workspace OAuth token);
 *    with no credential resolved they also return `null`. The actual vendor HTTP read is a deliberate future
 *    ADR — the structure is here so config can select a provider without a code change.
 */

import type { AnalyticsProvider, AnalyticsReading } from "./types.js";

/** The default provider: records an install but reports no numbers (no live vendor is contacted). */
export class DryRunAnalyticsProvider implements AnalyticsProvider {
  readonly id = "dryrun";
  async readMetrics(): Promise<AnalyticsReading | null> {
    return null;
  }
}

/** Resolves the vendor credential for a workspace, or `null` when none is connected. */
export type AnalyticsCredentialResolver = (workspaceId: string) => Promise<string | null>;

/**
 * GA4 read provider (live shape). Without a resolved credential it returns `null` (not connected). The
 * concrete Data API read is a future ADR; until then a connected workspace simply has no reading yet.
 */
export class Ga4AnalyticsProvider implements AnalyticsProvider {
  readonly id = "ga4";
  constructor(private readonly resolveCredential: AnalyticsCredentialResolver) {}
  async readMetrics(workspaceId: string): Promise<AnalyticsReading | null> {
    const credential = await this.resolveCredential(workspaceId);
    if (!credential) return null;
    // Live GA4 Data API read is a future ADR — a connected-but-unread workspace reports nothing yet.
    return null;
  }
}

/** Plausible read provider (live shape). Same contract as {@link Ga4AnalyticsProvider}. */
export class PlausibleAnalyticsProvider implements AnalyticsProvider {
  readonly id = "plausible";
  constructor(private readonly resolveCredential: AnalyticsCredentialResolver) {}
  async readMetrics(workspaceId: string): Promise<AnalyticsReading | null> {
    const credential = await this.resolveCredential(workspaceId);
    if (!credential) return null;
    return null;
  }
}

/** Select the read provider by config kind. Unknown / `dryrun` ⇒ the no-network dry-run provider. */
export function selectAnalyticsProvider(
  kind: string,
  resolveCredential: AnalyticsCredentialResolver,
): AnalyticsProvider {
  switch (kind) {
    case "ga4":
      return new Ga4AnalyticsProvider(resolveCredential);
    case "plausible":
      return new PlausibleAnalyticsProvider(resolveCredential);
    default:
      return new DryRunAnalyticsProvider();
  }
}
