/**
 * The pricing plan catalog (#125, ADR-0125) — a **pure, dependency-free** module that is the single
 * source of truth for both the `/pricing` web page and the server's checkout + activation paths.
 *
 * Each plan maps to the tenant caps the rest of the platform understands: `agentSeats` (how many agents
 * a customer can run), `monthlySessionBudgetCents` (the per-window spend ceiling on agent sessions —
 * the #71 `tenant_usage` / `[scale].budgetCents` cost cap), and `fleetSize` (the department fleet size).
 * `priceCents` is what we charge through the #98 `BillingProvider` seam.
 *
 * Voice (#122 ipop): chatty and warm, one wink per surface. Keep it fun, never cute-for-cute's-sake.
 */

export type PlanKey = "starter" | "pro" | "agency";
export type BillingInterval = "month" | "year";

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
    highlights: [
      "3 agent seats",
      "$200/mo session budget",
      "1 department fleet",
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
    highlights: [
      "10 agent seats",
      "$1,000/mo session budget",
      "3 department fleets",
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
    highlights: [
      "30 agent seats",
      "$5,000/mo session budget",
      "10 department fleets",
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
