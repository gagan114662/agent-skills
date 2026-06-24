/**
 * The AdsProvider read-back seam (#272, ADR-0272). Bid must report on real campaigns + real spend; the
 * premortem (#200 §3) forbids assuming — campaign and spend state is READ BACK from the ad provider API, and
 * an unwired/unconnected deployment degrades HONESTLY to "not connected" (`null`), never a fabricated
 * snapshot. Mirrors the connect-once `ConnectProvider` shape: a {@link DryRunAdsProvider} default that reads
 * back nothing, and a {@link MockAdsProvider} test/demo double.
 *
 * A provider response is UNTRUSTED web-derived content (#200 §6). {@link sanitizeAccountSnapshot} is the
 * structural boundary every read passes through before it reaches the fleet/console: it neutralizes free
 * text (campaign names), clamps spend to non-negative integers, and DERIVES the spend total from the line
 * items rather than trusting the provider's claimed total — wrapped as inert quarantined DATA (#267 pattern).
 */
import {
  quarantineProviderResult,
  sanitizeProviderText,
  type QuarantinedProviderResult,
} from "../provisioning/quarantine.js";

/** The capability id the ads connection unlocks (matches the `google_ads` connector's `capabilities`). */
export const ADS_CAPABILITY = "ads";
export const GOOGLE_ADS_PROVIDER_ID = "google_ads";
export const META_ADS_PROVIDER_ID = "meta_ads";
export const ADS_PROVIDER_IDS = [GOOGLE_ADS_PROVIDER_ID, META_ADS_PROVIDER_ID] as const;
export type AdsProviderId = (typeof ADS_PROVIDER_IDS)[number];

export function adsProviderIdForConnectedIds(
  connectedIds: ReadonlySet<string>,
): AdsProviderId | null {
  return ADS_PROVIDER_IDS.find((id) => connectedIds.has(id)) ?? null;
}

/** A single campaign's state as read back from the provider. */
export interface AdsCampaignSnapshot {
  campaignRef: string;
  name: string;
  /** Raw provider campaign status (e.g. `active`/`paused`). */
  status: string;
  /** Real spend to date, read back from the API (cents). */
  spentCents: number;
  /** The campaign's daily budget (cents). */
  dailyBudgetCents: number;
  /** The creative review states for this campaign's creatives (fed into `decideCreativeReview`). */
  creatives: AdsCreativeSnapshot[];
}

export interface AdsCreativeSnapshot {
  creativeRef: string;
  reviewState: string;
  reviewReason?: string | null;
  ageHours?: number;
}

/** The account's campaign + spend state, read back from the provider. */
export interface AdsAccountSnapshot {
  accountRef: string;
  currency: string;
  /** The provider's CLAIMED total — never trusted; {@link sanitizeAccountSnapshot} re-derives it. */
  totalSpentCents: number;
  campaigns: AdsCampaignSnapshot[];
}

export interface AdsProvider {
  /** Whether this provider can read back real data. The service degrades to "not connected" when false. */
  readonly live: boolean;
  /** Read back the account's campaign + spend state. Returns null when nothing real can be read. */
  getAccountState(input: {
    workspaceId: string;
    accountRef: string;
  }): Promise<AdsAccountSnapshot | null>;
}

/** The conservative production default: reads back NOTHING, so an unwired deployment is honestly empty. */
export class DryRunAdsProvider implements AdsProvider {
  readonly live = false;
  async getAccountState(): Promise<AdsAccountSnapshot | null> {
    return null;
  }
}

/** A test/demo double — returns a caller-supplied synthetic snapshot. Never makes a network call. */
export class MockAdsProvider implements AdsProvider {
  readonly live = true;
  constructor(private readonly snapshot: AdsAccountSnapshot | null) {}
  async getAccountState(): Promise<AdsAccountSnapshot | null> {
    return this.snapshot;
  }
}

function clampCents(value: number): number {
  const n = Math.floor(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A campaign snapshot after the untrusted-response boundary: free text neutralized, spend clamped. */
export interface SafeAdsCampaign {
  campaignRef: string;
  name: string;
  status: string;
  spentCents: number;
  dailyBudgetCents: number;
  creatives: AdsCreativeSnapshot[];
}

export interface SafeAdsAccount {
  accountRef: string;
  currency: string;
  /** Re-derived from the line items (the provider's claimed total is never trusted — #200 §3). */
  totalSpentCents: number;
  campaigns: SafeAdsCampaign[];
}

/**
 * Wrap a raw provider snapshot as inert quarantined DATA (#267/#200 §6). The `provider` id is STRUCTURAL
 * (from the caller's routing decision), never read from the body. Free text is sanitized, spend is clamped to
 * non-negative integers, and the total is DERIVED from the line items. Total + pure.
 */
export function sanitizeAccountSnapshot(
  provider: string,
  snapshot: AdsAccountSnapshot,
): QuarantinedProviderResult<SafeAdsAccount> {
  const campaigns: SafeAdsCampaign[] = snapshot.campaigns.map((c) => ({
    campaignRef: sanitizeProviderText(c.campaignRef).slice(0, 120),
    name: sanitizeProviderText(c.name),
    status: sanitizeProviderText(c.status).slice(0, 40),
    spentCents: clampCents(c.spentCents),
    dailyBudgetCents: clampCents(c.dailyBudgetCents),
    // The creative review states pass through structurally; `decideCreativeReview` sanitizes each reason.
    creatives: c.creatives.map((cr) => ({
      creativeRef: sanitizeProviderText(cr.creativeRef).slice(0, 120),
      reviewState: sanitizeProviderText(cr.reviewState).slice(0, 60),
      reviewReason: cr.reviewReason ?? null,
      ageHours: Number.isFinite(cr.ageHours) ? cr.ageHours : undefined,
    })),
  }));
  const totalSpentCents = campaigns.reduce((sum, c) => sum + c.spentCents, 0);
  const data: SafeAdsAccount = {
    accountRef: sanitizeProviderText(snapshot.accountRef).slice(0, 120),
    currency: sanitizeProviderText(snapshot.currency).slice(0, 8) || "USD",
    totalSpentCents,
    campaigns,
  };
  return quarantineProviderResult(ADS_CAPABILITY, provider, data);
}
