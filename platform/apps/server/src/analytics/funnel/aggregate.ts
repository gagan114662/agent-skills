/**
 * Full-funnel aggregation (#604) — the pure math that turns the raw event log into the ONE funnel view.
 *
 * **Pure + unit-tested**, mirroring the #102 `growth/score.ts` split: the service does the IO (record the
 * event, read the window); these functions fold events into per-stage counts, the stage-to-stage
 * conversion rates (each guarded into `[0,1]`), and the SAME funnel broken down by `channel` and by `agent`
 * so the acceptance criterion — "each stage's conversion rate is measurable and broken down by
 * channel/agent" — is computed here, deterministically, with no hidden state.
 */

import { isFunnelStage, type FunnelEvent } from "./schema.js";

/** Summed `value` per funnel stage. */
export interface FunnelCounts {
  visit: number;
  signup: number;
  activation: number;
  paid: number;
}

/** Stage-to-stage conversion rates, each guarded into `[0,1]`. */
export interface FunnelStageRates {
  /** signup / visit. */
  signupRate: number;
  /** activation / signup. */
  activationRate: number;
  /** paid / activation. */
  paidRate: number;
  /** paid / visit — the end-to-end visit→paid rate. */
  overallRate: number;
}

/** One breakdown row: a channel or agent key, its own counts, and its own rates. */
export interface FunnelBreakdownRow {
  key: string;
  counts: FunnelCounts;
  rates: FunnelStageRates;
}

/** The one funnel view: overall roll-up plus the channel + agent breakdowns. */
export interface FunnelView {
  counts: FunnelCounts;
  rates: FunnelStageRates;
  /** Per-channel funnels, highest-traffic (visit) first. */
  byChannel: FunnelBreakdownRow[];
  /** Per-agent funnels, highest-traffic (visit) first. */
  byAgent: FunnelBreakdownRow[];
  /** How many raw events fed the view (provenance for the console). */
  eventCount: number;
}

function emptyCounts(): FunnelCounts {
  return { visit: 0, signup: 0, activation: 0, paid: 0 };
}

/** Clamp a ratio into `[0,1]`, treating a non-positive denominator (and NaN) as 0. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const r = numerator / denominator;
  if (Number.isNaN(r)) return 0;
  return Math.max(0, Math.min(1, r));
}

/** Sum each event's `value` into its stage; non-positive values and unknown stages are ignored. */
export function countsFromEvents(events: readonly FunnelEvent[]): FunnelCounts {
  const counts = emptyCounts();
  for (const e of events) {
    if (!isFunnelStage(e.stage)) continue;
    if (typeof e.value !== "number" || e.value <= 0) continue;
    counts[e.stage] += e.value;
  }
  return counts;
}

/** Stage-to-stage conversion rates, each guarded into `[0,1]` (`x/0 = 0`). */
export function stageRates(counts: FunnelCounts): FunnelStageRates {
  return {
    signupRate: ratio(counts.signup, counts.visit),
    activationRate: ratio(counts.activation, counts.signup),
    paidRate: ratio(counts.paid, counts.activation),
    overallRate: ratio(counts.paid, counts.visit),
  };
}

/** Group events by a key selector, compute each group's counts + rates, sort by visit volume desc. */
function breakdown(
  events: readonly FunnelEvent[],
  keyOf: (e: FunnelEvent) => string,
): FunnelBreakdownRow[] {
  const groups = new Map<string, FunnelEvent[]>();
  for (const e of events) {
    const key = keyOf(e);
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }
  const rows: FunnelBreakdownRow[] = [];
  for (const [key, group] of groups) {
    const counts = countsFromEvents(group);
    rows.push({ key, counts, rates: stageRates(counts) });
  }
  // Highest-traffic first; ties broken by key ascending for a stable, deterministic order.
  rows.sort((a, b) => b.counts.visit - a.counts.visit || a.key.localeCompare(b.key));
  return rows;
}

/**
 * Fold the event log into the one funnel view: overall counts + rates, plus the same funnel broken down by
 * `channel` and by `agent`. Deterministic and side-effect-free.
 */
export function aggregateFunnel(events: readonly FunnelEvent[]): FunnelView {
  const counts = countsFromEvents(events);
  return {
    counts,
    rates: stageRates(counts),
    byChannel: breakdown(events, (e) => e.channel),
    byAgent: breakdown(events, (e) => e.agent),
    eventCount: events.length,
  };
}
