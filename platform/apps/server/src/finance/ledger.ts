/**
 * Finance Ledger pure core (#194, ADR-0194). **No IO, no clock of its own** (every instant is passed
 * in) so the whole accounting model is unit-tested in isolation — the #173 / #104 pure-core pattern.
 * The IO orchestrator (`service.ts`) gathers external receipts and persists; `default.ts` wires the
 * real repos. Nothing here mutates or moves money: it turns receipts into ledger postings and folds a
 * period's postings into a closed book, a runway forecast, and a money-decision recommendation.
 *
 * The premortem (#200) is encoded structurally: every posting carries `verified` + `source` + a
 * `sourceRef` to the external receipt; numbers derived from an internal estimate (compute-seconds ×
 * rate, ADR-0040) are `verified: false` and a close pack reports the `verifiedShareBps` so the owner
 * sees exactly how much of the books rests on external receipts. Money is double-entry-ish: a posting
 * is a `credit` (inflow) or a `debit` (outflow); `net = Σcredit − Σdebit`. Amounts are always
 * non-negative integer cents — the sign is the direction, never the number.
 */

// ---- postings ----------------------------------------------------------------------------------

/** Inflow (`credit`, revenue) or outflow (`debit`, cost). The sign of a posting in the net. */
export type LedgerDirection = "credit" | "debit";

/** Where a posting came from. `stripe_event` is an external receipt (verified); `tenant_usage` is an
 * internal estimate (UNVERIFIED); `manual` is an owner-entered cost (UNVERIFIED until a receipt backs it). */
export type LedgerSource = "stripe_event" | "tenant_usage" | "manual";

/** A posting ready for the store. Idempotent on `(workspaceId, source, sourceRef)` — the upsert key. */
export interface LedgerPosting {
  workspaceId: string;
  /** The venture this maps to, or `null` for a workspace-level (unattributed) entry. */
  ventureIdeaId: string | null;
  direction: LedgerDirection;
  /** Coarse account, e.g. `revenue.stripe`, `cost.model`, `cost.infra`, `cost.ad`. */
  category: string;
  /** Always ≥ 0; the direction carries the sign. */
  amountCents: number;
  currency: string;
  /** `true` only when backed by an external receipt (a Stripe event). Estimates/manual are `false`. */
  verified: boolean;
  source: LedgerSource;
  /** The external receipt id this posting dedupes on (provider event id / usage window key / manual ref). */
  sourceRef: string;
  /** When the economic event happened (epoch ms) — the period-bucketing basis. */
  occurredAtMs: number;
  memo: string | null;
}

/** A persisted ledger entry (a posting + its row id and creation time). */
export interface LedgerEntry extends LedgerPosting {
  id: string;
  createdAtMs: number;
}

/** The minimal verified inbound revenue receipt (a #98 `revenue_events` row). */
export interface RevenueReceipt {
  providerEventId: string;
  amountCents: number;
  currency: string;
  createdAtMs: number;
  ventureIdeaId?: string | null;
  /**
   * The #386 tracking ref carried through Stripe checkout metadata (slice 3). Optional/null for receipts
   * that carried no ref or sources that do not track it (e.g. per-venture monetization). The finance ledger
   * itself ignores this field; it rides along so the #386 attribution projection can credit an artifact.
   */
  trackingRef?: string | null;
}

/** A verified `credit` posting from a Stripe revenue event. */
export function postingFromRevenueEvent(workspaceId: string, ev: RevenueReceipt): LedgerPosting {
  return {
    workspaceId,
    ventureIdeaId: ev.ventureIdeaId ?? null,
    direction: "credit",
    category: "revenue.stripe",
    amountCents: Math.max(0, Math.round(ev.amountCents)),
    currency: ev.currency.toLowerCase(),
    verified: true,
    source: "stripe_event",
    sourceRef: ev.providerEventId,
    occurredAtMs: ev.createdAtMs,
    memo: null,
  };
}

/**
 * An **UNVERIFIED** `debit` posting from a `tenant_usage` window's estimated model spend (#71). It is
 * an estimate (ADR-0040: compute-seconds × rate, rate defaults 0), so `verified: false` and the
 * `sourceRef` is the `YYYY-MM` window key — one posting per window, refreshed (upserted) as the window
 * accrues. `occurredAtMs` anchors the entry in that window's period.
 */
export function postingFromUsageWindow(
  workspaceId: string,
  windowKey: string,
  estimatedCostCents: number,
  occurredAtMs: number,
  currency = "usd",
): LedgerPosting {
  return {
    workspaceId,
    ventureIdeaId: null,
    direction: "debit",
    category: "cost.model",
    amountCents: Math.max(0, Math.round(estimatedCostCents)),
    currency: currency.toLowerCase(),
    verified: false,
    source: "tenant_usage",
    sourceRef: windowKey,
    occurredAtMs,
    memo: "estimated model spend (UNVERIFIED — compute-seconds × rate)",
  };
}

/** The signed cents a posting contributes to the net: `+amount` for a credit, `−amount` for a debit. */
export function signedCents(entry: Pick<LedgerPosting, "direction" | "amountCents">): number {
  return entry.direction === "credit" ? entry.amountCents : -entry.amountCents;
}

// ---- period bucketing --------------------------------------------------------------------------

/** The calendar period (UTC `YYYY-MM`) an instant falls in — the close-pack + forecast bucket. */
export function periodKeyOf(occurredAtMs: number): string {
  const d = new Date(occurredAtMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The `count` period keys up to and including `period`, oldest→newest (the forecast lookback). */
export function recentPeriodKeys(period: string, count: number): string[] {
  if (count <= 0) return [];
  const [y, m] = period.split("-").map((n) => Number(n));
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y!, m! - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

// ---- unit economics ----------------------------------------------------------------------------

/** Inputs for unit economics. Counts that aren't known are omitted → the derived metric is `null`. */
export interface UnitEconomicsInput {
  revenueCents: number;
  costCents: number;
  /** New paying customers acquired in the period (for CAC). Unknown ⇒ omit ⇒ `cacCents: null`. */
  newCustomers?: number;
  /** Active paying customers in the period (for ARPU/LTV). Unknown ⇒ omit ⇒ `ltvCents: null`. */
  activeCustomers?: number;
  /** Expected customer lifetime in months (for LTV). Defaults to 1 (one period) when omitted. */
  avgLifetimeMonths?: number;
}

/** Unit economics — every field `null` unless its inputs exist. Never fabricates a number. */
export interface UnitEconomics {
  /** Customer Acquisition Cost = cost ÷ new customers, cents. `null` if new-customer count unknown. */
  cacCents: number | null;
  /** Lifetime Value = ARPU × lifetime, cents. `null` if active-customer count unknown. */
  ltvCents: number | null;
  /** Gross margin in basis points = net ÷ revenue × 10000. `null` if no revenue. */
  marginBps: number | null;
  /** LTV:CAC ratio ×100 (so 300 = 3.0×). `null` if either side is unknown/zero. */
  ltvToCacX100: number | null;
}

export function computeUnitEconomics(input: UnitEconomicsInput): UnitEconomics {
  const { revenueCents, costCents } = input;
  const net = revenueCents - costCents;
  const cacCents =
    input.newCustomers && input.newCustomers > 0
      ? Math.round(costCents / input.newCustomers)
      : null;
  const lifetime = input.avgLifetimeMonths && input.avgLifetimeMonths > 0 ? input.avgLifetimeMonths : 1;
  const ltvCents =
    input.activeCustomers && input.activeCustomers > 0
      ? Math.round((revenueCents / input.activeCustomers) * lifetime)
      : null;
  const marginBps = revenueCents > 0 ? Math.round((net / revenueCents) * 10000) : null;
  const ltvToCacX100 =
    ltvCents !== null && cacCents !== null && cacCents > 0
      ? Math.round((ltvCents / cacCents) * 100)
      : null;
  return { cacCents, ltvCents, marginBps, ltvToCacX100 };
}

// ---- close pack --------------------------------------------------------------------------------

export interface ClosePackInput {
  workspaceId: string;
  /** The venture this close is for, or `null` for the workspace-level book. */
  ventureIdeaId: string | null;
  periodKey: string;
  currency: string;
  /** The postings (already filtered to this scope + period by the caller). */
  entries: LedgerPosting[];
  /** Optional customer counts for unit economics (otherwise those fields are `null`). */
  customers?: { newCustomers?: number; activeCustomers?: number; avgLifetimeMonths?: number };
}

/** A closed monthly book — the "books that close themselves" snapshot, attached to the #173 report. */
export interface ClosePack {
  workspaceId: string;
  ventureIdeaId: string | null;
  periodKey: string;
  currency: string;
  revenueCents: number;
  costCents: number;
  /** The externally-verified subset of `costCents` (a Stripe-fee/payout receipt would land here). */
  verifiedCostCents: number;
  /** `revenueCents − costCents`, signed (negative ⇒ the venture lost money this period). */
  netCents: number;
  /** Verified revenue (all revenue is from Stripe events today → equals `revenueCents`). */
  verifiedRevenueCents: number;
  /**
   * Basis points (0–10000) of the period's total money magnitude (Σ|amount|) that is externally
   * verified. The premortem's "% externally-verified metrics" per close. 10000 = fully receipted;
   * a period whose only cost is the UNVERIFIED model-spend estimate scores below that.
   */
  verifiedShareBps: number;
  entryCount: number;
  unitEconomics: UnitEconomics;
}

export function composeClosePack(input: ClosePackInput): ClosePack {
  const inScope = input.entries;
  let revenueCents = 0;
  let costCents = 0;
  let verifiedRevenueCents = 0;
  let verifiedCostCents = 0;
  let verifiedMagnitude = 0;
  let totalMagnitude = 0;
  for (const e of inScope) {
    totalMagnitude += e.amountCents;
    if (e.verified) verifiedMagnitude += e.amountCents;
    if (e.direction === "credit") {
      revenueCents += e.amountCents;
      if (e.verified) verifiedRevenueCents += e.amountCents;
    } else {
      costCents += e.amountCents;
      if (e.verified) verifiedCostCents += e.amountCents;
    }
  }
  const verifiedShareBps =
    totalMagnitude > 0 ? Math.round((verifiedMagnitude / totalMagnitude) * 10000) : 0;
  return {
    workspaceId: input.workspaceId,
    ventureIdeaId: input.ventureIdeaId,
    periodKey: input.periodKey,
    currency: input.currency.toLowerCase(),
    revenueCents,
    costCents,
    verifiedCostCents,
    netCents: revenueCents - costCents,
    verifiedRevenueCents,
    verifiedShareBps,
    entryCount: inScope.length,
    unitEconomics: computeUnitEconomics({
      revenueCents,
      costCents,
      newCustomers: input.customers?.newCustomers,
      activeCustomers: input.customers?.activeCustomers,
      avgLifetimeMonths: input.customers?.avgLifetimeMonths,
    }),
  };
}

// ---- runway forecast ---------------------------------------------------------------------------

export interface RunwayInput {
  workspaceId: string;
  currency: string;
  /** The current cash position (cumulative verified revenue − all costs to date), cents. */
  cashPositionCents: number;
  /** Recent CLOSED periods oldest→newest — the burn-rate basis. Each has its net + verified net. */
  periods: Array<{ periodKey: string; netCents: number; verifiedNetCents: number }>;
  /** Number of periods requested for the burn-rate lookback, including any missing close packs. */
  lookbackPeriodCount?: number;
  /** Lookback period keys that had no close pack and were excluded from the burn-rate average. */
  incompletePeriodKeys?: string[];
  /** The current period (the forecast projects from here). */
  currentPeriodKey: string;
  /** Floor the balance must stay above; a breach is predicted when the projection crosses it. Cents. */
  floorCents?: number;
}

export type RunwayHealth = "healthy" | "at_risk" | "breached";

export interface RunwayForecast {
  workspaceId: string;
  currency: string;
  cashPositionCents: number;
  /** Mean monthly net over the lookback (negative ⇒ burning). */
  monthlyNetCents: number;
  /** Mean monthly net counting ONLY verified flows — how much of the trend rests on receipts. */
  verifiedMonthlyNetCents: number;
  /** Requested lookback size for the burn basis. */
  lookbackPeriodCount: number;
  /** Closed periods actually used in the burn average. */
  closedPeriodCount: number;
  /** Missing/incomplete lookback periods excluded from the burn average. */
  incompletePeriodCount: number;
  /** Specific lookback period keys excluded because no close pack exists. */
  incompletePeriodKeys: string[];
  /** Monthly burn (positive number) when net is negative; 0 when net ≥ 0 (not burning). */
  monthlyBurnCents: number;
  /** Estimated runway in days from the cash position at the current burn; `null` when not burning. */
  runwayDays: number | null;
  /** The `YYYY-MM` the balance is predicted to cross the floor; `null` when not burning / already below. */
  breachPeriodKey: string | null;
  /** How many whole months until the predicted breach; `null` when not burning. */
  monthsToBreach: number | null;
  health: RunwayHealth;
}

const DAYS_PER_MONTH = 30;

/**
 * Project runway from the recent closed periods. Pure. Burn = the mean monthly net when it is negative.
 * `runwayDays` = cash ÷ daily burn. The breach period is the first future month the projected balance
 * drops below the floor — predicted **before** it happens. `health`: `breached` if already below the
 * floor; `at_risk` if a breach is within `atRiskMonths` (default 3); else `healthy`.
 */
export function runwayForecast(input: RunwayInput, atRiskMonths = 3): RunwayForecast {
  const floor = input.floorCents ?? 0;
  const n = input.periods.length;
  const lookbackPeriodCount = Math.max(input.lookbackPeriodCount ?? n, n);
  const incompletePeriodKeys = input.incompletePeriodKeys ?? [];
  const sum = input.periods.reduce((a, p) => a + p.netCents, 0);
  const verifiedSum = input.periods.reduce((a, p) => a + p.verifiedNetCents, 0);
  const monthlyNetCents = n > 0 ? Math.round(sum / n) : 0;
  const verifiedMonthlyNetCents = n > 0 ? Math.round(verifiedSum / n) : 0;
  const monthlyBurnCents = monthlyNetCents < 0 ? -monthlyNetCents : 0;

  let runwayDays: number | null = null;
  let breachPeriodKey: string | null = null;
  let monthsToBreach: number | null = null;
  let health: RunwayHealth;

  if (input.cashPositionCents <= floor) {
    health = "breached";
  } else if (monthlyBurnCents <= 0) {
    health = "healthy";
  } else {
    const headroom = input.cashPositionCents - floor;
    runwayDays = Math.max(0, Math.floor((headroom / monthlyBurnCents) * DAYS_PER_MONTH));
    monthsToBreach = Math.ceil(headroom / monthlyBurnCents);
    breachPeriodKey = addMonths(input.currentPeriodKey, monthsToBreach);
    health = monthsToBreach <= atRiskMonths ? "at_risk" : "healthy";
  }

  return {
    workspaceId: input.workspaceId,
    currency: input.currency.toLowerCase(),
    cashPositionCents: input.cashPositionCents,
    monthlyNetCents,
    verifiedMonthlyNetCents,
    lookbackPeriodCount,
    closedPeriodCount: n,
    incompletePeriodCount: Math.max(0, lookbackPeriodCount - n),
    incompletePeriodKeys,
    monthlyBurnCents,
    runwayDays,
    breachPeriodKey,
    monthsToBreach,
    health,
  };
}

/** `period` (`YYYY-MM`) advanced by `months` whole months. */
export function addMonths(period: string, months: number): string {
  const [y, m] = period.split("-").map((n) => Number(n));
  const d = new Date(Date.UTC(y!, m! - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- money-decision recommendation -------------------------------------------------------------

export type MoneyRecommendation = "approve" | "caution" | "hold";

export interface MoneyDecisionInput {
  /** The money the decision spends/disburses, cents (≥ 0). */
  amountCents: number;
  currency: string;
  /** The runway forecast the spend is evaluated against. */
  runway: Pick<RunwayForecast, "cashPositionCents" | "monthlyBurnCents" | "currency">;
  /** Floor the post-spend balance must stay above. Cents. Default 0. */
  floorCents?: number;
  /** At/below this many post-spend runway days ⇒ `caution`. Default 30. */
  cautionRunwayDays?: number;
}

export interface MoneyDecisionRecommendation {
  amountCents: number;
  currency: string;
  /** The cash position after the spend, cents (may be negative). */
  balanceAfterCents: number;
  /** Runway days after the spend at the current burn; `null` when not burning. */
  runwayDaysAfter: number | null;
  recommendation: MoneyRecommendation;
  reason: string;
}

/**
 * Annotate a money decision with its runway impact + a recommendation — the "amount + runway impact +
 * recommendation" the one money queue (#13) shows. Pure; it never approves or moves money. `hold` when
 * the spend would push the balance below the floor; `caution` when it leaves thin runway; else `approve`.
 */
export function recommendMoneyDecision(input: MoneyDecisionInput): MoneyDecisionRecommendation {
  const floor = input.floorCents ?? 0;
  const cautionDays = input.cautionRunwayDays ?? 30;
  const amountCents = Math.max(0, Math.round(input.amountCents));
  const balanceAfterCents = input.runway.cashPositionCents - amountCents;
  const burn = input.runway.monthlyBurnCents;
  const runwayDaysAfter =
    burn > 0
      ? Math.max(0, Math.floor(((balanceAfterCents - floor) / burn) * DAYS_PER_MONTH))
      : null;

  let recommendation: MoneyRecommendation;
  let reason: string;
  if (balanceAfterCents < floor) {
    recommendation = "hold";
    reason = "spend would push the balance below the safety floor";
  } else if (runwayDaysAfter !== null && runwayDaysAfter <= cautionDays) {
    recommendation = "caution";
    reason = `leaves ~${runwayDaysAfter}d of runway at the current burn`;
  } else {
    recommendation = "approve";
    reason =
      runwayDaysAfter === null
        ? "no active burn; spend does not threaten runway"
        : `leaves ~${runwayDaysAfter}d of runway`;
  }
  return {
    amountCents,
    currency: input.currency.toLowerCase(),
    balanceAfterCents,
    runwayDaysAfter,
    recommendation,
    reason,
  };
}
