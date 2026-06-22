/**
 * Per-agent performance scorecard tied to conversions (issue #593) — pure data shapes. No IO, no clock, no
 * randomness.
 *
 * The problem #593 fixes: there is no way to know which agent (and which channel) actually drove paying
 * customers. The fix is a scorecard that attributes PIPELINE and REVENUE back to the agent + channel that
 * ORIGINATED the touch, updated as conversions land, so the user can rank agents by revenue/pipeline influenced.
 *
 * Two kinds of input feed the scorecard:
 *
 *   - CONVERSION EVENTS ({@link ConversionEvent}) — the outcomes that "land" over time. Each event credits a
 *     monetary amount (pipeline value, or realized revenue) to the agent + channel that originated it. This is
 *     the accumulating ledger; it is what makes the scorecard "tied to conversions".
 *   - AGENT ACTIVITY ({@link AgentActivity}) — how much outreach work each agent did (touches). This is the
 *     denominator for a conversion RATE, so a low-volume agent with a few big wins is distinguishable from a
 *     high-volume agent grinding out the same revenue.
 *
 * The output ({@link AgentScorecard}) attributes pipeline + revenue per agent, breaks it down per channel, and
 * carries an explainable 0–100 influence score the cohort is ranked by. Like the #611 lead-scoring and #741
 * avatar-studio modules, the scoring itself is a self-contained PURE library: callers feed it DATA and get DATA
 * back — no route, schema barrel, or migration wiring.
 */

/**
 * What kind of value a conversion event credits:
 *   - `pipeline` — value that entered the pipeline (a qualified opportunity). Influential but NOT yet realized.
 *   - `revenue`  — realized, closed-won revenue. The thing that actually pays the bills.
 *
 * Splitting the two lets the scorecard rank by realized revenue while still surfacing the pipeline an agent is
 * building — and lets a UI weight unrealized pipeline below booked revenue (see {@link ScorecardOptions}).
 */
export type ConversionKind = "pipeline" | "revenue";

/**
 * One conversion outcome attributed to its ORIGINATING agent + channel. Events accumulate over time ("updated as
 * conversions land"); each carries a stable `eventId` so re-ingesting the same feed is idempotent (the store
 * dedupes on it).
 */
export interface ConversionEvent {
  /** Stable, idempotent id from the source — the dedup key when events are ingested repeatedly. */
  eventId: string;
  /** The agent credited as the originator of the touch that led to this conversion. */
  agentId: string;
  /** The channel the originating touch came through (e.g. `email`, `ads`, `social`). Blank → `unknown`. */
  channel: string;
  /** Whether this credits pipeline value or realized revenue. */
  kind: ConversionKind;
  /** Monetary value in USD: pipeline value for `pipeline`, realized revenue for `revenue`. Coerced ≥ 0. */
  amountUsd: number;
  /** Opaque customer/account key — lets the scorecard count DISTINCT customers influenced. Optional. */
  customerId?: string;
  /** When the conversion landed. */
  occurredAt: Date;
}

/**
 * How much outreach an agent did over the scoring window — the denominator for a conversion rate. Keyed per
 * (agentId, channel); the scorer sums `touches` across an agent's channels. All counts are coerced to a
 * non-negative integer (absence ⇒ 0, never negative).
 */
export interface AgentActivity {
  agentId: string;
  /** The channel these touches went through. Blank → `unknown`. */
  channel: string;
  /** Number of outreach touches/tasks the agent performed through this channel. */
  touches: number;
}

/** The conversion ledger + activity for one workspace — the full input to {@link buildScorecard}. */
export interface ScorecardInput {
  events: readonly ConversionEvent[];
  activities: readonly AgentActivity[];
}

/** Per-channel slice of one agent's attribution — "where did this agent's pipeline/revenue come from?". */
export interface ChannelStat {
  channel: string;
  pipelineUsd: number;
  revenueUsd: number;
  /** Total conversion events (pipeline + revenue) attributed to this agent on this channel. */
  conversions: number;
  /** Touches the agent made on this channel (from activity), for a per-channel conversion rate. */
  touches: number;
}

/**
 * The scorecard for a single agent. `pipelineUsd` / `revenueUsd` are the headline attribution; `influenceUsd` is
 * the blended figure the cohort is ranked by (revenue plus pipeline discounted by {@link ScorecardOptions.pipelineWeight});
 * `score` is that influence normalized to 0–100 against the cohort leader (the top agent scores 100). Every
 * derived number is reconstructable from `pipelineUsd`, `revenueUsd`, `conversions`, and `touches`, so the
 * scorecard is auditable rather than a black box.
 */
export interface AgentScorecard {
  agentId: string;
  /** Realized, closed-won revenue attributed to this agent (USD). */
  revenueUsd: number;
  /** Pipeline value (qualified, not yet realized) attributed to this agent (USD). */
  pipelineUsd: number;
  /** Blended influence = revenueUsd + pipelineWeight × pipelineUsd. The default ranking key. */
  influenceUsd: number;
  /** Total conversion events (pipeline + revenue) attributed to this agent. */
  conversions: number;
  /** Count of realized-revenue events (the `revenue` kind) — "deals closed". */
  revenueConversions: number;
  /** Distinct customers this agent influenced (by `customerId`; events without one are not counted as distinct). */
  influencedCustomers: number;
  /** Total outreach touches across the agent's channels (from activity). */
  touches: number;
  /** Realized conversions per touch (revenueConversions / touches), `0` when touches is `0`. */
  conversionRate: number;
  /** Per-channel attribution, ranked by influence (revenue, then pipeline) descending. */
  channels: ChannelStat[];
  /** The channel that produced the most revenue (ties → most pipeline), or `null` when the agent has no events. */
  topChannel: string | null;
  /** Cohort-normalized influence, 0–100 (the leader is 100). Pure given the whole cohort. */
  score: number;
  /** 1-based position after ranking. */
  rank: number;
  /** One-line natural-language headline of this agent's attribution. */
  summary: string;
}

/** Cohort-level totals across every agent — the denominator for "share of revenue/pipeline". */
export interface ScorecardTotals {
  revenueUsd: number;
  pipelineUsd: number;
  influenceUsd: number;
  conversions: number;
  agents: number;
}

/** The complete, ranked scorecard for a workspace: every agent plus the cohort totals. */
export interface Scorecard {
  agents: AgentScorecard[];
  totals: ScorecardTotals;
}
