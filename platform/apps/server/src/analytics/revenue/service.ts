/**
 * Revenue analytics service (#614, #615) — the read surface for multi-touch attribution + the dashboard.
 *
 * Pure orchestration over the injected reader seams (`store.ts`), exactly like the #667 `CostObservabilityService`
 * and the #194 `FinanceService`: unit-tested with fakes, bound to the real repos in `default.ts`. It never
 * writes — the touches, receipts, spend, and pipeline are all produced elsewhere; this only reads them and
 * turns them into journeys + the dashboard. All math lives in the pure `attribution.ts`/`dashboard.ts`. Every
 * method is workspace-scoped (#3 IDOR discipline) and takes the clock from `now` (no `Date.now` in this layer).
 */

import { buildJourneys } from "./attribution.js";
import { buildDashboard } from "./dashboard.js";
import {
  DEFAULT_ATTRIBUTION_MODEL,
  type AttributionModel,
  type CustomerJourney,
  type DashboardSnapshot,
} from "./types.js";
import type { PipelineReader, RevenueReader, SpendReader, TouchReader } from "./store.js";

/** A trailing window measured in days. `0` ⇒ full history (no lower bound). */
export const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The default touch-lookback before the window start when building the dashboard's journeys: a payment in
 * the window may have been influenced by a touch that landed weeks earlier, so journeys are built over a
 * wider touch window than the revenue window (90 days) to avoid under-attributing. Also the default
 * staleness ceiling for a touch to earn credit.
 */
export const DEFAULT_MAX_CHAIN_AGE_MS = 90 * DAY_MS;

export interface RevenueAnalyticsDeps {
  touches: TouchReader;
  revenue: RevenueReader;
  /** Optional — the dashboard shows `spend = 0` honestly when cost accounting is unavailable. */
  spend?: SpendReader;
  /** Optional — the dashboard shows an empty pipeline honestly when there are no links. */
  pipeline?: PipelineReader;
  /** The workspace billing currency (the #98 billing config). */
  currency: (workspaceId: string) => string;
  /** A touch older than this before a payment earns no credit. Default {@link DEFAULT_MAX_CHAIN_AGE_MS}. */
  maxChainAgeMs?: number;
  /** Clock seam (epoch ms). The pure core never calls `Date.now` — this layer injects the instant. */
  now: () => number;
}

export interface JourneyQuery {
  /** Trailing window for the payments considered. Default {@link DEFAULT_WINDOW_DAYS}; `0` ⇒ full history. */
  windowDays?: number;
  /** The multi-touch model. Default `linear`. */
  model?: AttributionModel;
}

export interface DashboardQuery extends JourneyQuery {
  /** How many top journeys to surface. Default 10. */
  topJourneys?: number;
}

export class RevenueAnalyticsService {
  constructor(private readonly deps: RevenueAnalyticsDeps) {}

  private maxChainAgeMs(): number {
    return this.deps.maxChainAgeMs ?? DEFAULT_MAX_CHAIN_AGE_MS;
  }

  private windowSinceMs(windowDays: number, nowMs: number): number | null {
    return windowDays > 0 ? nowMs - windowDays * DAY_MS : null;
  }

  /**
   * Build the multi-touch journeys for every paying customer in the window (#614). Touches are read over a
   * wider lookback (window − maxChainAge) so an in-window payment still picks up the earlier touch that
   * influenced it; only happened-before touches earn credit.
   */
  async journeys(workspaceId: string, query: JourneyQuery = {}): Promise<CustomerJourney[]> {
    const nowMs = this.deps.now();
    const windowDays = query.windowDays ?? DEFAULT_WINDOW_DAYS;
    const model = query.model ?? DEFAULT_ATTRIBUTION_MODEL;
    const sinceMs = this.windowSinceMs(windowDays, nowMs);
    const touchSinceMs = sinceMs === null ? undefined : Math.max(0, sinceMs - this.maxChainAgeMs());

    const [touches, payments] = await Promise.all([
      this.deps.touches.listTouches(workspaceId, touchSinceMs),
      this.deps.revenue.listPayments(workspaceId, sinceMs ?? undefined),
    ]);
    return buildJourneys(touches, payments, { model, maxChainAgeMs: this.maxChainAgeMs() });
  }

  /**
   * The end-to-end journey for ONE paying customer (#614 acceptance): the full chain of agent actions +
   * channels that influenced them, plus the multi-touch credit split. Built over full history so no
   * influencing touch is missed. Returns null when the ref has no payment (not a paying customer).
   */
  async customerJourney(
    workspaceId: string,
    customerRef: string,
    model: AttributionModel = DEFAULT_ATTRIBUTION_MODEL,
  ): Promise<CustomerJourney | null> {
    const [touches, payments] = await Promise.all([
      this.deps.touches.listTouches(workspaceId),
      this.deps.revenue.listPayments(workspaceId),
    ]);
    const journeys = buildJourneys(
      touches.filter((t) => t.customerRef === customerRef),
      payments.filter((p) => p.customerRef === customerRef),
      { model, maxChainAgeMs: this.maxChainAgeMs() },
    );
    return journeys[0] ?? null;
  }

  /**
   * The one glanceable dashboard (#615): revenue, paying customers, pipeline, spend, net, daily trend, and
   * the multi-touch channel/agent breakdowns — all scoped to the caller's workspace and trailing window.
   */
  async dashboard(workspaceId: string, query: DashboardQuery = {}): Promise<DashboardSnapshot> {
    const nowMs = this.deps.now();
    const windowDays = query.windowDays ?? DEFAULT_WINDOW_DAYS;
    const model = query.model ?? DEFAULT_ATTRIBUTION_MODEL;
    const sinceMs = this.windowSinceMs(windowDays, nowMs);
    const touchSinceMs = sinceMs === null ? undefined : Math.max(0, sinceMs - this.maxChainAgeMs());

    const [touches, payments, spend, pipeline] = await Promise.all([
      this.deps.touches.listTouches(workspaceId, touchSinceMs),
      this.deps.revenue.listPayments(workspaceId, sinceMs ?? undefined),
      this.deps.spend?.dailySpendMicros(workspaceId, sinceMs ?? undefined) ?? Promise.resolve([]),
      this.deps.pipeline?.listOpen(workspaceId) ?? Promise.resolve([]),
    ]);

    const journeys = buildJourneys(touches, payments, { model, maxChainAgeMs: this.maxChainAgeMs() });
    return buildDashboard(
      { journeys, payments, spend, pipeline, currency: this.deps.currency(workspaceId), model },
      { sinceMs, untilMs: nowMs, nowMs, topJourneys: query.topJourneys },
    );
  }
}
