/**
 * Acquisition execution — provider seams + dry-run defaults (issue #189, ADR-0189).
 *
 * Each channel talks to the outside world through a narrow provider interface. The DEFAULT provider for
 * every channel is a **dry-run**: it performs no network egress, returns a `sent` outcome stamped
 * `dryRun:true`, and is what runs in CI/tests and in any deployment that has not connected a real
 * provider. This mirrors `billingRefund` (recorded-only) and `DryRunDnsProvider` (#192): real adapters
 * (Google/Meta Ads, Postmark/SendGrid, X/LinkedIn) are deliberately a future, lazily-loaded step behind
 * connected credentials — never an autonomous call baked into the default path.
 *
 * No IO here beyond what a real adapter would do; the dry-run impls are pure-deterministic given their
 * input id, so they are unit-testable without a clock or network.
 */

export type SendStatus = "sent" | "failed";

export interface SendOutcome {
  status: SendStatus;
  /** The provider's message/campaign id — an EXTERNAL receipt (premortem #200 §2/§3), null on dry-run-less. */
  externalId: string | null;
  /** The provider kind that handled it (`dryrun` | `google` | `postmark` | ...). */
  provider: string;
  detail: Record<string, unknown>;
}

export interface AdSpendInput {
  workspaceId: string;
  ideaId: string | null;
  campaign: string;
  amountCents: number;
}
export interface EmailSendInput {
  workspaceId: string;
  ideaId: string | null;
  subject: string;
  body: string;
  recipients: string[];
}
export interface SocialPostInput {
  workspaceId: string;
  ideaId: string | null;
  network: string;
  text: string;
}
export interface SeoPublishInput {
  workspaceId: string;
  ideaId: string | null;
  section: string;
  slug: string;
  title: string;
}

export interface AdsProvider {
  readonly kind: string;
  spend(input: AdSpendInput): Promise<SendOutcome>;
}
export interface EspProvider {
  readonly kind: string;
  send(input: EmailSendInput): Promise<SendOutcome>;
}
export interface SocialProvider {
  readonly kind: string;
  publish(input: SocialPostInput): Promise<SendOutcome>;
}
export interface SeoPublishProvider {
  readonly kind: string;
  publish(input: SeoPublishInput): Promise<SendOutcome>;
}

/** A deterministic, network-free receipt id for the dry-run path (derived from a stable seed). */
function dryRunId(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `dryrun:${(h >>> 0).toString(16)}`;
}

/** Dry-run ads provider — records the intended spend, makes no real campaign change. */
export const dryRunAdsProvider: AdsProvider = {
  kind: "dryrun",
  spend(input) {
    return Promise.resolve({
      status: "sent",
      externalId: dryRunId(`ad:${input.workspaceId}:${input.campaign}:${input.amountCents}`),
      provider: "dryrun",
      detail: { dryRun: true, campaign: input.campaign, amountCents: input.amountCents },
    });
  },
};

/** Dry-run ESP — records the intended email, sends nothing. */
export const dryRunEspProvider: EspProvider = {
  kind: "dryrun",
  send(input) {
    return Promise.resolve({
      status: "sent",
      externalId: dryRunId(`email:${input.workspaceId}:${input.subject}:${input.recipients.join(",")}`),
      provider: "dryrun",
      detail: { dryRun: true, recipientCount: input.recipients.length },
    });
  },
};

/** Dry-run social provider — records the intended post, publishes nothing. */
export const dryRunSocialProvider: SocialProvider = {
  kind: "dryrun",
  publish(input) {
    return Promise.resolve({
      status: "sent",
      externalId: dryRunId(`social:${input.workspaceId}:${input.network}:${input.text}`),
      provider: "dryrun",
      detail: { dryRun: true, network: input.network },
    });
  },
};

/** Dry-run SEO publisher — records the intended publish, writes nothing live. */
export const dryRunSeoProvider: SeoPublishProvider = {
  kind: "dryrun",
  publish(input) {
    return Promise.resolve({
      status: "sent",
      externalId: dryRunId(`seo:${input.workspaceId}:${input.section}:${input.slug}`),
      provider: "dryrun",
      detail: { dryRun: true, section: input.section, slug: input.slug },
    });
  },
};

/**
 * The provider set the dispatcher uses. The factory returns the dry-run set for every kind except a
 * recognized real one — and there are no real adapters yet (they are a deliberate future ADR, gated on
 * connected credentials), so today every kind resolves to dry-run. An explicit `override` lets tests /
 * a future wiring inject a real provider without changing the call sites.
 */
export interface AcquisitionProviders {
  ads: AdsProvider;
  esp: EspProvider;
  social: SocialProvider;
  seo: SeoPublishProvider;
}

export interface ProviderKinds {
  adsProvider?: string;
  espProvider?: string;
  socialProvider?: string;
}

export function createAcquisitionProviders(
  _kinds: ProviderKinds,
  override?: Partial<AcquisitionProviders>,
): AcquisitionProviders {
  // No real adapters are wired yet: any configured kind other than an injected override falls back to
  // dry-run, so the default path NEVER reaches the network. Wiring a real adapter is a future ADR.
  return {
    ads: override?.ads ?? dryRunAdsProvider,
    esp: override?.esp ?? dryRunEspProvider,
    social: override?.social ?? dryRunSocialProvider,
    seo: override?.seo ?? dryRunSeoProvider,
  };
}
