/**
 * The daily revenue/pipeline/spend dashboard rollup (#615) — pure assembly of the one glanceable view.
 *
 * Given the customer journeys (multi-touch attributed, from `attribution.ts`), the raw payments, per-day
 * spend (the #667 cost rollup), and open pipeline (#98 payment links), this builds the headline totals, a
 * per-UTC-day revenue+spend trend, the attributed channel/agent breakdowns, and the top journeys — the
 * "is the system actually making money?" answer in one object.
 *
 * Pure: no IO, no clock. Money math only sums data that already exists; spend joins revenue in micro-dollars
 * (1 cent = 10,000 micros) to match the #667 cost accounting. The caller (`service.ts`) injects `now` and the
 * already-windowed inputs.
 */

import { rollupByAgent, rollupByChannel } from "./attribution.js";
import {
  type CustomerJourney,
  type DailyRevenuePoint,
  type DashboardSnapshot,
  type DashboardTotals,
  type Payment,
  type PipelineEntry,
  type RetentionCohort,
  type RetentionSnapshot,
  type AttributionModel,
} from "./types.js";

/** 1 cent expressed in micro-dollars — the unit the #667 cost rollup reports spend in. */
export const MICROS_PER_CENT = 10_000;

/** One day of operating spend (micro-dollars), keyed by UTC calendar day — the #667 cost rollup shape. */
export interface DailySpend {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  micros: number;
}

/** The UTC calendar-day key for an epoch-ms timestamp, `YYYY-MM-DD`. */
export function dayKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC calendar-month key for an epoch-ms timestamp, `YYYY-MM`. */
export function monthKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export interface BuildDashboardInput {
  journeys: readonly CustomerJourney[];
  /** Every payment in the window (including unattributed ones — they still count as revenue). */
  payments: readonly Payment[];
  /** Per-day operating spend in the window (the #667 cost rollup); empty when cost accounting is off. */
  spend?: readonly DailySpend[];
  /** Open pipeline items — potential revenue in flight; empty when there are none. */
  pipeline?: readonly PipelineEntry[];
  currency: string;
  model: AttributionModel;
}

export interface BuildDashboardOptions {
  sinceMs: number | null;
  untilMs: number;
  nowMs: number;
  /** How many top journeys to surface. Default 10. */
  topJourneys?: number;
}

/** Sum revenue/customers/payment-count per UTC day, then merge in per-day spend; ascending by date. */
function buildTrend(payments: readonly Payment[], spend: readonly DailySpend[]): DailyRevenuePoint[] {
  const byDay = new Map<string, { revenueCents: number; paymentCount: number; customers: Set<string>; spendMicros: number }>();
  const ensure = (date: string) => {
    let row = byDay.get(date);
    if (!row) {
      row = { revenueCents: 0, paymentCount: 0, customers: new Set<string>(), spendMicros: 0 };
      byDay.set(date, row);
    }
    return row;
  };
  for (const p of payments) {
    const row = ensure(dayKeyUtc(p.paidAtMs));
    row.revenueCents += p.amountCents;
    row.paymentCount += 1;
    row.customers.add(p.customerRef);
  }
  for (const s of spend) {
    ensure(s.date).spendMicros += s.micros;
  }
  return [...byDay.entries()]
    .map(([date, v]) => ({
      date,
      revenueCents: v.revenueCents,
      paymentCount: v.paymentCount,
      payingCustomers: v.customers.size,
      spendMicros: v.spendMicros,
      netMicros: v.revenueCents * MICROS_PER_CENT - v.spendMicros,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function monthOffset(fromMonth: string, toMonth: string): number {
  const [fromYear = 0, from = 1] = fromMonth.split("-").map(Number);
  const [toYear = 0, to = 1] = toMonth.split("-").map(Number);
  return (toYear - fromYear) * 12 + (to - from);
}

function buildRetention(payments: readonly Payment[]): RetentionSnapshot {
  const byCustomer = new Map<string, Payment[]>();
  for (const p of payments) {
    const rows = byCustomer.get(p.customerRef) ?? [];
    rows.push(p);
    byCustomer.set(p.customerRef, rows);
  }

  const cohortCustomers = new Map<string, Set<string>>();
  const cohortRevenue = new Map<string, number>();
  const cohortMonthRevenue = new Map<string, Map<string, { customers: Set<string>; revenueCents: number }>>();

  for (const [customerRef, rows] of byCustomer) {
    rows.sort((a, b) => a.paidAtMs - b.paidAtMs);
    const cohortMonth = monthKeyUtc(rows[0]!.paidAtMs);
    if (!cohortCustomers.has(cohortMonth)) cohortCustomers.set(cohortMonth, new Set());
    cohortCustomers.get(cohortMonth)!.add(customerRef);
    if (!cohortMonthRevenue.has(cohortMonth)) cohortMonthRevenue.set(cohortMonth, new Map());

    for (const p of rows) {
      const paidMonth = monthKeyUtc(p.paidAtMs);
      const monthRows = cohortMonthRevenue.get(cohortMonth)!;
      const row = monthRows.get(paidMonth) ?? { customers: new Set<string>(), revenueCents: 0 };
      row.customers.add(customerRef);
      row.revenueCents += p.amountCents;
      monthRows.set(paidMonth, row);
      if (paidMonth === cohortMonth) {
        cohortRevenue.set(cohortMonth, (cohortRevenue.get(cohortMonth) ?? 0) + p.amountCents);
      }
    }
  }

  const churnSpikes: RetentionSnapshot["churnSpikes"] = [];
  const cohorts: RetentionCohort[] = [...cohortCustomers.entries()]
    .map(([cohortMonth, customers]) => {
      const baseCustomers = customers.size;
      const baseRevenue = cohortRevenue.get(cohortMonth) ?? 0;
      const monthRows = cohortMonthRevenue.get(cohortMonth) ?? new Map();
      let previousRetention: number | null = null;
      const points = [...monthRows.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([month, row]) => {
          const customerRetention = baseCustomers > 0 ? row.customers.size / baseCustomers : 0;
          const revenueRetention = baseRevenue > 0 ? row.revenueCents / baseRevenue : 0;
          const drop = previousRetention === null ? 0 : previousRetention - customerRetention;
          const churnSpike = drop >= 0.25;
          if (churnSpike) churnSpikes.push({ cohortMonth, month, drop });
          previousRetention = customerRetention;
          return {
            month,
            monthOffset: monthOffset(cohortMonth, month),
            activeCustomers: row.customers.size,
            revenueCents: row.revenueCents,
            customerRetention,
            revenueRetention,
            churnSpike,
          };
        });
      return { cohortMonth, customers: baseCustomers, revenueCents: baseRevenue, points };
    })
    .sort((a, b) => (a.cohortMonth < b.cohortMonth ? -1 : a.cohortMonth > b.cohortMonth ? 1 : 0));

  return { cohorts, churnSpikes };
}

/**
 * Build the one dashboard snapshot (#615) from the windowed inputs. `payments` drives revenue + paying
 * customers (every real payment counts, attributed or not); `journeys` drives the multi-touch channel/agent
 * breakdowns and the top-journeys list; `spend`/`pipeline` fill the spend and pipeline headlines.
 */
export function buildDashboard(input: BuildDashboardInput, opts: BuildDashboardOptions): DashboardSnapshot {
  const spend = input.spend ?? [];
  const pipeline = input.pipeline ?? [];
  const topN = opts.topJourneys ?? 10;

  const revenueCents = input.payments.reduce((sum, p) => sum + p.amountCents, 0);
  const paymentCount = input.payments.length;
  const payingCustomers = new Set(input.payments.map((p) => p.customerRef)).size;
  const spendMicros = spend.reduce((sum, s) => sum + s.micros, 0);
  const pipelineOpenCents = pipeline.reduce((sum, e) => sum + e.estValueCents, 0);
  const revenueMicros = revenueCents * MICROS_PER_CENT;

  const totals: DashboardTotals = {
    currency: input.currency,
    revenueCents,
    payingCustomers,
    paymentCount,
    avgOrderValueCents: paymentCount > 0 ? Math.round(revenueCents / paymentCount) : 0,
    pipelineOpenCents,
    pipelineOpenCount: pipeline.length,
    spendMicros,
    netMicros: revenueMicros - spendMicros,
    roi: spendMicros > 0 ? revenueMicros / spendMicros : null,
  };

  return {
    window: {
      sinceMs: opts.sinceMs,
      untilMs: opts.untilMs,
      days: opts.sinceMs === null ? 0 : Math.max(0, Math.round((opts.untilMs - opts.sinceMs) / 86_400_000)),
    },
    generatedAtMs: opts.nowMs,
    model: input.model,
    totals,
    trend: buildTrend(input.payments, spend),
    byChannel: rollupByChannel(input.journeys),
    byAgent: rollupByAgent(input.journeys),
    topJourneys: input.journeys.slice(0, topN),
    retention: buildRetention(input.payments),
  };
}
