/**
 * First-dollar GTM wedge (#396). This is intentionally pure data + tiny selectors: the agent fleet can
 * consume it when drafting offers, ICPs, Reach batches, and checkout attribution without inventing a new
 * strategy on every run.
 */

export const FIRST_DOLLAR_WEDGE_ID = "solo-b2b-founder-with-marketing-backlog" as const;

export type FirstDollarReachChannel =
  | "warm_founder_dm"
  | "linkedin_permitted_api"
  | "email_with_checkout_ref"
  | "build_in_public_post";

export interface FirstDollarSuccessMetric {
  readonly windowDays: number;
  readonly event: "external_signup_reaches_stripe_checkout";
  readonly minimumCount: number;
  readonly attributionRefPrefix: string;
}

export interface FirstDollarWedge {
  readonly id: typeof FIRST_DOLLAR_WEDGE_ID;
  readonly buyer: {
    readonly segment: "b2b_founder";
    readonly companyStage: "pre_seed_to_seed";
    readonly teamSize: "1_20";
    readonly roleTitles: readonly string[];
    readonly urgentJob: string;
    readonly disqualifiers: readonly string[];
  };
  readonly offer: {
    readonly promise: string;
    readonly firstDeliverable: string;
    readonly proofRequired: readonly string[];
    readonly cta: string;
  };
  readonly reach: {
    readonly fastestHonestChannel: FirstDollarReachChannel;
    readonly backupChannels: readonly FirstDollarReachChannel[];
    readonly liveChannelDependencyIssue: number;
    readonly allowedBeforeLiveOutbound: readonly FirstDollarReachChannel[];
    readonly blockedUntilLiveOutbound: readonly FirstDollarReachChannel[];
  };
  readonly successMetric: FirstDollarSuccessMetric;
  readonly agentInstructions: readonly string[];
}

export const FIRST_DOLLAR_GTM_WEDGE: FirstDollarWedge = {
  id: FIRST_DOLLAR_WEDGE_ID,
  buyer: {
    segment: "b2b_founder",
    companyStage: "pre_seed_to_seed",
    teamSize: "1_20",
    roleTitles: ["founder", "ceo", "head of growth"],
    urgentJob:
      "Turn an underused product or launch into qualified conversations this week without hiring a marketing team.",
    disqualifiers: [
      "enterprise procurement cycle",
      "no working product or checkout path",
      "consumer-only audience with no clear buyer",
    ],
  },
  offer: {
    promise:
      "ipop gives a founder a tiny autonomous marketing team that finds the first credible buyers, writes the offer, and moves one prospect to checkout.",
    firstDeliverable:
      "A 48-hour buyer-and-channel sprint: ICP, 25 sourced prospects, owner-reviewed outbound copy, live checkout tracking, and a receipts report.",
    proofRequired: [
      "all prospects have a cited external signal",
      "every outbound touch carries a tracking ref",
      "the win condition is a real external signup reaching Stripe checkout",
    ],
    cta: "Start the 48-hour first-customer sprint",
  },
  reach: {
    fastestHonestChannel: "email_with_checkout_ref",
    backupChannels: ["warm_founder_dm", "linkedin_permitted_api", "build_in_public_post"],
    liveChannelDependencyIssue: 395,
    allowedBeforeLiveOutbound: ["build_in_public_post", "warm_founder_dm"],
    blockedUntilLiveOutbound: ["email_with_checkout_ref", "linkedin_permitted_api"],
  },
  successMetric: {
    windowDays: 7,
    event: "external_signup_reaches_stripe_checkout",
    minimumCount: 1,
    attributionRefPrefix: "ipop-first-dollar-",
  },
  agentInstructions: [
    "Do not optimize generic SEO before this wedge has one external checkout attempt.",
    "Lead with the founder's immediate revenue job, not a broad autonomous-company platform story.",
    "Publish positioning autonomously only to owned surfaces; direct outbound waits for the live channel gate.",
    "Money-out, paid lists, ads, and customer spend remain approval-gated.",
  ],
};

export function firstDollarTrackingRef(seed: string): string {
  const cleaned = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return FIRST_DOLLAR_GTM_WEDGE.successMetric.attributionRefPrefix + (cleaned || "unknown");
}

export function firstDollarReachPlan(liveOutboundEnabled: boolean): readonly FirstDollarReachChannel[] {
  if (liveOutboundEnabled) {
    return [
      FIRST_DOLLAR_GTM_WEDGE.reach.fastestHonestChannel,
      ...FIRST_DOLLAR_GTM_WEDGE.reach.backupChannels,
    ];
  }
  return FIRST_DOLLAR_GTM_WEDGE.reach.allowedBeforeLiveOutbound;
}

export function firstDollarMetricReached(events: readonly { event: string; external: boolean }[]): boolean {
  const metric = FIRST_DOLLAR_GTM_WEDGE.successMetric;
  const count = events.filter((event) => event.external && event.event === metric.event).length;
  return count >= metric.minimumCount;
}
