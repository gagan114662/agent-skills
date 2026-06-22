/**
 * Multi-touch revenue attribution + the daily revenue/pipeline/spend dashboard (#614, #615) — domain types.
 *
 * Two issues, one cohesive analytics module:
 *  - #614 ties each PAYING customer back to the FULL chain of agent actions + channels that influenced them
 *    (a {@link CustomerJourney} of ordered {@link Touch}es with a multi-touch credit split), rather than
 *    crediting a single originating artifact the way the #386 single-touch ledger does.
 *  - #615 rolls those journeys, the raw payments, spend, and open pipeline into one glanceable
 *    {@link DashboardSnapshot}: revenue, paying customers, pipeline, spend, net, and a daily trend.
 *
 * Pure types — no IO, no clock. The credit math lives in `attribution.ts`, the rollup in `dashboard.ts`,
 * the seams in `store.ts`, and the real-repo wiring in `default.ts`. Self-contained and migration-free: the
 * module only READS data that already exists (the #386 exposures, the #98 revenue receipts, the #667 cost
 * rollup, the #98 payment links) — it adds no table and no money path.
 *
 * Currency note: a journey carries the currency of its payments; rollups and totals assume a single
 * workspace billing currency (the #98 billing config). Mixed-currency cents are summed naively — honest for
 * the single-currency workspaces this serves, and never fabricated.
 */

/**
 * The multi-touch credit models. Each distributes one customer's paid revenue across the ordered touches
 * that influenced them, summing (modulo integer rounding) to the amount paid:
 *  - `first_touch`    — 100% to the touch that first reached the customer (acquisition credit).
 *  - `last_touch`     — 100% to the touch immediately before the payment (conversion credit).
 *  - `linear`         — split evenly across every touch (the neutral default).
 *  - `position_based` — 40% first, 40% last, the remaining 20% split evenly across the middle (U-shaped).
 */
export const ATTRIBUTION_MODELS = ["first_touch", "last_touch", "linear", "position_based"] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

/** The neutral multi-touch default when no model is specified. */
export const DEFAULT_ATTRIBUTION_MODEL: AttributionModel = "linear";

export function isAttributionModel(value: unknown): value is AttributionModel {
  return typeof value === "string" && (ATTRIBUTION_MODELS as readonly string[]).includes(value);
}

/** The breakdown-key used for a touch/payment that arrived with no channel attribution. */
export const UNATTRIBUTED_CHANNEL = "direct";
/** The breakdown-key used for a touch that arrived with no driving agent. */
export const UNATTRIBUTED_AGENT = "none";

/**
 * One influence touch in a customer's journey: an agent action shown on a channel, tied to a paying
 * customer by a stable `customerRef` (the #386 tracking ref carried through checkout). The head-to-tail
 * sequence of these IS the "full chain of agent actions + channels" #614 asks for.
 */
export interface Touch {
  /** Stable key tying touches to ONE paying customer — the #386 tracking ref (or a synthetic per-payment id). */
  customerRef: string;
  /** The acquisition channel (`seo`, `social`, `email`, `ads`, …); `direct` when unattributed. */
  channel: string;
  /** The agent/member that drove the touch (`mark`, `scout`, …); `none` when unattributed. */
  agent: string;
  /** The artifact/touch kind (`seo_page`, `social_post`, `email`, `ad`, …). */
  kind: string;
  /** The fleet artifact this touch came from (a live URL, a post id, a PR url). */
  artifactId: string;
  /** When the touch happened (epoch ms). The pure core never reads a clock — this is supplied data. */
  occurredAtMs: number;
}

/** A verified inbound payment — the apex of a journey, and the ONLY source of a revenue number. */
export interface Payment {
  /** The customer this payment belongs to (the same join key the touches carry). */
  customerRef: string;
  /** Provider event id — the external receipt that makes this real (a Stripe event id). */
  providerEventId: string;
  amountCents: number;
  currency: string;
  /** When the payment settled (epoch ms). */
  paidAtMs: number;
}

/** A touch with the share of journey revenue a multi-touch model assigned to it. */
export interface TouchCredit {
  channel: string;
  agent: string;
  kind: string;
  artifactId: string;
  occurredAtMs: number;
  /** The model's fractional share for this touch, 0..1. */
  weight: number;
  /** Integer cents credited to this touch (`credits` sums to the journey's `totalPaidCents`). */
  creditCents: number;
}

/**
 * A paying customer's end-to-end journey (#614): every influencing touch (ordered earliest→latest), the
 * payment(s) that closed them, and the multi-touch credit split. A paying customer with NO matched touch is
 * still a journey — `touches`/`credits` are empty and the revenue is honestly unattributed, never fabricated.
 */
export interface CustomerJourney {
  customerRef: string;
  currency: string;
  /** Touches that happened-before the payment, ordered earliest→latest. */
  touches: Touch[];
  payments: Payment[];
  totalPaidCents: number;
  paymentCount: number;
  /** Earliest touch time (ms), or null when the customer has no matched touch. */
  firstTouchAtMs: number | null;
  /** Latest touch time (ms), or null when the customer has no matched touch. */
  lastTouchAtMs: number | null;
  /** Earliest payment time (ms) — the conversion anchor. */
  paidAtMs: number;
  touchCount: number;
  /** Distinct channels in order of first appearance. */
  channels: string[];
  /** Distinct agents in order of first appearance. */
  agents: string[];
  model: AttributionModel;
  /** The multi-touch credit split (sums to `totalPaidCents` modulo integer rounding). */
  credits: TouchCredit[];
}

/** Attributed revenue rolled up by one dimension (a channel or an agent). */
export interface DimensionCredit {
  key: string;
  /** Sum of credit cents this dimension earned across all journeys (multi-touch). */
  attributedCents: number;
  /** How many touches in this dimension earned credit. */
  touchCount: number;
  /** How many distinct paying customers this dimension influenced. */
  customerCount: number;
}

/** One day in the dashboard's revenue/spend trend (UTC calendar day). */
export interface DailyRevenuePoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  revenueCents: number;
  paymentCount: number;
  /** Distinct paying customers that settled on this day. */
  payingCustomers: number;
  /** Operating spend on this day (micro-dollars; the #667 cost rollup). */
  spendMicros: number;
  /** `revenue − spend` for the day in micro-dollars (1 cent = 10,000 micros). */
  netMicros: number;
}

/** One open pipeline item — potential revenue in flight (a #98 payment link minted but not yet realized). */
export interface PipelineEntry {
  /** A stable id for the pipeline item (the payment link id). */
  ref: string;
  label: string;
  channel: string;
  agent: string;
  estValueCents: number;
  currency: string;
  /** Where this sits in the funnel (`link_minted`, `signup`, `activation`, …). */
  stage: string;
  updatedAtMs: number;
}

/** The glanceable headline numbers (#615). Micro-dollars where a value joins the #667 cost rollup. */
export interface DashboardTotals {
  currency: string;
  revenueCents: number;
  /** Distinct paying customers in the window. */
  payingCustomers: number;
  paymentCount: number;
  /** `revenueCents / paymentCount`, rounded; 0 when there were no payments. */
  avgOrderValueCents: number;
  /** Total value of open pipeline items (offers on the table). */
  pipelineOpenCents: number;
  pipelineOpenCount: number;
  /** Operating spend in the window (micro-dollars; the #667 cost rollup). */
  spendMicros: number;
  /** `revenue − spend` in micro-dollars (1 cent = 10,000 micros). Negative when spend outran revenue. */
  netMicros: number;
  /** `revenueMicros / spendMicros` — return on spend; null when there was no spend. */
  roi: number | null;
}

/** The one dashboard view (#615): headline totals, a daily trend, attribution breakdowns, and top journeys. */
export interface DashboardSnapshot {
  window: { sinceMs: number | null; untilMs: number; days: number };
  generatedAtMs: number;
  model: AttributionModel;
  totals: DashboardTotals;
  /** Per-UTC-day revenue + spend, ascending. */
  trend: DailyRevenuePoint[];
  /** Multi-touch attributed revenue by channel, highest first. */
  byChannel: DimensionCredit[];
  /** Multi-touch attributed revenue by agent, highest first. */
  byAgent: DimensionCredit[];
  /** The highest-revenue customer journeys (a glanceable "who paid + why" list). */
  topJourneys: CustomerJourney[];
}
