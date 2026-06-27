/**
 * The pricing plan catalog (#125, ADR-0125) — a **pure, dependency-free** module that is the single
 * source of truth for both the `/pricing` web page and the server's checkout + activation paths.
 *
 * Each plan maps to the tenant caps the rest of the platform understands: `agentSeats` (how many agents
 * a customer can run), `monthlySessionBudgetCents` (the per-window spend ceiling on agent sessions —
 * the #71 `tenant_usage` / `[scale].budgetCents` cost cap), `fleetSize` (the department fleet size), and
 * `productLimits` (the buyer-visible daily/workspace limits that become upgrade moments). `priceCents`
 * is what we charge through the #98 `BillingProvider` seam.
 *
 * Voice (#122 ipop): chatty and warm, one wink per surface. Keep it fun, never cute-for-cute's-sake.
 */

export type PlanKey = "starter" | "pro" | "agency";
export type BillingInterval = "month" | "year";

export interface PlanProductLimits {
  /** Parallel campaign lanes that can be active before the workspace needs a larger plan. */
  readonly activeCampaignLanes: number;
  /** Live connected outbound channels (Google, iMessage, X, LinkedIn, Ads, etc.). */
  readonly connectedChannels: number;
  /** Approved outbound sends the agents may attempt per day. */
  readonly dailyOutreachSends: number;
  /** Pending approvals that can wait in the founder queue at once. */
  readonly approvalQueueSize: number;
  /** Days of dashboard/proof history retained in the live workspace. */
  readonly dashboardHistoryDays: number;
}

export interface Plan {
  /** Stable key — used in checkout metadata, the price registry, and the URL. */
  readonly key: PlanKey;
  /** Display name on the card. */
  readonly name: string;
  /** One warm, chatty line under the name (ipop voice). */
  readonly tagline: string;
  /** Monthly price in the smallest currency unit (cents). */
  readonly priceCents: number;
  /** ISO 4217 currency. */
  readonly currency: string;
  /** Default billing interval. Checkout may request the annual variant. */
  readonly interval: BillingInterval;
  /** Tenant cap: number of agent seats. */
  readonly agentSeats: number;
  /** Tenant cap: monthly spend ceiling on agent sessions (cents) — maps to the #71 budget cap. */
  readonly monthlySessionBudgetCents: number;
  /** Tenant cap: department fleet size. */
  readonly fleetSize: number;
  /** Buyer-visible plan limits that drive quota meters and upgrade prompts. */
  readonly productLimits: PlanProductLimits;
  /** Outcome-first summary: what useful work this tier should produce every day. */
  readonly dailyValue: string;
  /** The plain-English limit that turns value into an upgrade moment. */
  readonly dailyLimit: string;
  /** The "upgrade when..." line shown beside the plan instead of hiding the ask. */
  readonly upgradeTrigger: string;
  /** Feature bullets rendered on the card. */
  readonly highlights: readonly string[];
  /** The one recommended tier (rendered with a "most popular" treatment). */
  readonly featured: boolean;
}

/** The tenant-cap projection of a plan — what activation writes to `workspace_plans`. */
export interface PlanCaps {
  agentSeats: number;
  monthlySessionBudgetCents: number;
  fleetSize: number;
}

export type PlanLimitMetric = keyof PlanProductLimits | keyof PlanCaps;

export interface PlanLimitDecision {
  allowed: boolean;
  limit: number;
  used: number;
  requested: number;
  remaining: number;
  message: string;
  upgradeTrigger: string;
}

/** Starter → Pro → Agency, ascending price. The order is load-bearing: the page renders left→right. */
export const PLANS: readonly Plan[] = [
  {
    key: "starter",
    name: "Starter",
    tagline: "Hire your first three agents and see what a tiny team can ship.",
    priceCents: 4900,
    currency: "usd",
    interval: "month",
    agentSeats: 3,
    monthlySessionBudgetCents: 20_000,
    fleetSize: 1,
    productLimits: {
      activeCampaignLanes: 1,
      connectedChannels: 1,
      dailyOutreachSends: 25,
      approvalQueueSize: 20,
      dashboardHistoryDays: 14,
    },
    dailyValue: "A daily marketing checkup: site read, quick-win plan, and one draft your team can use.",
    dailyLimit: "1 active campaign, 3 agents, and a $200 monthly agent-work cap.",
    upgradeTrigger: "Upgrade when you want the agents to keep working after the first campaign lane fills up.",
    highlights: [
      "Daily SEO/content/social check-ins",
      "3 agent seats for one focused lane",
      "$200/mo agent-work cap with receipts",
      "Approvals + audit trail included",
    ],
    featured: false,
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "A proper marketing team that never sleeps. This is the one most folks pick.",
    priceCents: 19_900,
    currency: "usd",
    interval: "month",
    agentSeats: 10,
    monthlySessionBudgetCents: 100_000,
    fleetSize: 3,
    productLimits: {
      activeCampaignLanes: 3,
      connectedChannels: 3,
      dailyOutreachSends: 150,
      approvalQueueSize: 75,
      dashboardHistoryDays: 90,
    },
    dailyValue: "A working growth room every day: SEO, content, outreach, and analytics moving together.",
    dailyLimit: "3 active campaign lanes, 10 agents, and a $1,000 monthly agent-work cap.",
    upgradeTrigger: "Upgrade when you need more brands, clients, or parallel departments running at once.",
    highlights: [
      "Daily multi-agent growth standup",
      "10 agent seats across 3 lanes",
      "$1,000/mo agent-work cap with receipts",
      "Priority autonomy + deploy-to-live",
    ],
    featured: true,
  },
  {
    key: "agency",
    name: "Agency",
    tagline: "A whole building of agents. Spin up departments like you mean it.",
    priceCents: 49_900,
    currency: "usd",
    interval: "month",
    agentSeats: 30,
    monthlySessionBudgetCents: 500_000,
    fleetSize: 10,
    productLimits: {
      activeCampaignLanes: 10,
      connectedChannels: 10,
      dailyOutreachSends: 750,
      approvalQueueSize: 250,
      dashboardHistoryDays: 365,
    },
    dailyValue: "Every day, a full agency floor: multiple brands, launches, and client workstreams in parallel.",
    dailyLimit: "10 active campaign lanes, 30 agents, and a $5,000 monthly agent-work cap.",
    upgradeTrigger: "Talk to us when you need custom controls, procurement, or a bigger cap.",
    highlights: [
      "Daily cross-client mission control",
      "30 agent seats across 10 lanes",
      "$5,000/mo agent-work cap with receipts",
      "Everything in Pro, at scale",
    ],
    featured: false,
  },
];

const BY_KEY: ReadonlyMap<string, Plan> = new Map(PLANS.map((p) => [p.key, p]));

/** Narrow an arbitrary string to a known {@link PlanKey}. */
export function isPlanKey(key: string): key is PlanKey {
  return BY_KEY.has(key);
}

/** Resolve a plan by key, or `undefined` for an unknown key. */
export function getPlan(key: string): Plan | undefined {
  return BY_KEY.get(key);
}

export function isBillingInterval(raw: string): raw is BillingInterval {
  return raw === "month" || raw === "year";
}

/** Annual self-serve checkout uses the common SaaS "two months free" framing. */
export function planPriceCents(plan: Plan, interval: BillingInterval): number {
  return interval === "year" ? plan.priceCents * 10 : plan.priceCents;
}

/** Project a plan down to the tenant-cap dimensions persisted on activation. Pure. */
export function planCaps(plan: Plan): PlanCaps {
  return {
    agentSeats: plan.agentSeats,
    monthlySessionBudgetCents: plan.monthlySessionBudgetCents,
    fleetSize: plan.fleetSize,
  };
}

export function planLimitValue(plan: Plan, metric: PlanLimitMetric): number {
  if (metric in plan.productLimits) return plan.productLimits[metric as keyof PlanProductLimits];
  return plan[metric as keyof PlanCaps];
}

/** Pure quota decision used by server routes before starting paid work. */
export function evaluatePlanLimit(
  plan: Plan,
  metric: PlanLimitMetric,
  used: number,
  requested = 1,
): PlanLimitDecision {
  const limit = planLimitValue(plan, metric);
  const normalizedUsed = Math.max(0, Math.trunc(used));
  const normalizedRequested = Math.max(1, Math.trunc(requested));
  const remainingBeforeRequest = Math.max(0, limit - normalizedUsed);
  const allowed = normalizedRequested <= remainingBeforeRequest;
  return {
    allowed,
    limit,
    used: normalizedUsed,
    requested: normalizedRequested,
    remaining: allowed ? remainingBeforeRequest - normalizedRequested : remainingBeforeRequest,
    message: allowed
      ? `${plan.name} has ${remainingBeforeRequest - normalizedRequested} ${metric} remaining.`
      : `${plan.name} allows ${limit} ${metric}; ${remainingBeforeRequest} remain before this request.`,
    upgradeTrigger: plan.upgradeTrigger,
  };
}
