/**
 * Full-funnel event schema (#604) — the ONE consistent contract shared by the marketing site and the
 * product.
 *
 * Without this, the marketing site and the product each invent their own event names and the funnel can
 * never be joined end-to-end. This module is that single vocabulary: the four full-funnel stages
 * (`visit → signup → activation → paid`), the `surface` that says which side of the product emitted the
 * event (`marketing` | `product`), and the two attribution dimensions every stage carries (`channel` and
 * `agent`) so each stage's conversion rate is measurable *and* breakable-down by where the traffic came
 * from and which agent drove it.
 *
 * Pure + dependency-free: a const-tuple taxonomy with `is*` guards plus one `normalizeFunnelEvent` ingest
 * helper, mirroring the #102 `growth/types.ts` split. {@link normalizeFunnelEvent} is the single door a raw
 * inbound payload (from either surface) passes through, so a bad stage/surface/value is rejected once, here,
 * and never reaches the aggregator. It never reads or trusts free-form `metadata` as control flow (#200 §6).
 */

/**
 * The four full-funnel stages, in order. Bounded + stable (each is a low-cardinality label, never
 * free-form), so they can index counts and be CHECK-constrained if ever persisted:
 *  - `visit`      — a landing on the marketing site (top of funnel).
 *  - `signup`     — an account/lead created.
 *  - `activation` — the first real value moment inside the product.
 *  - `paid`       — a paid conversion (money).
 */
export const FUNNEL_STAGES = ["visit", "signup", "activation", "paid"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export function isFunnelStage(value: unknown): value is FunnelStage {
  return typeof value === "string" && (FUNNEL_STAGES as readonly string[]).includes(value);
}

/**
 * Which side of the product emitted the event — the seam that makes the funnel genuinely end-to-end:
 * `visit`/`signup` typically arrive from `marketing`, `activation`/`paid` from `product`, but the schema is
 * uniform so either surface may emit any stage.
 */
export const FUNNEL_SURFACES = ["marketing", "product"] as const;
export type FunnelSurface = (typeof FUNNEL_SURFACES)[number];

export function isFunnelSurface(value: unknown): value is FunnelSurface {
  return typeof value === "string" && (FUNNEL_SURFACES as readonly string[]).includes(value);
}

/** The breakdown-key used when an event arrives with no channel attribution. */
export const UNATTRIBUTED_CHANNEL = "direct";
/** The breakdown-key used when an event arrives with no driving agent. */
export const UNATTRIBUTED_AGENT = "none";

/**
 * One normalized funnel event — the durable, workspace-scoped instrumentation record. Identical shape from
 * either surface (that is the whole point: one consistent schema).
 */
export interface FunnelEvent {
  workspaceId: string;
  stage: FunnelStage;
  /** Which side emitted it (`marketing` | `product`). */
  surface: FunnelSurface;
  /** The acquisition channel (e.g. `producthunt`, `organic`, `ads`); `direct` when unattributed. */
  channel: string;
  /** The agent/member that drove the event (e.g. `mark`, `scout`); `none` when unattributed. */
  agent: string;
  /** The count/weight this event carries (always > 0). */
  value: number;
  occurredAt: Date;
  /** Free-form drill-down bag (path, campaign, variant) — never aggregated, never trusted as control. */
  metadata: Record<string, unknown>;
}

/** The raw, partially-typed payload an ingest call carries before normalization. */
export interface RawFunnelEvent {
  stage: unknown;
  surface?: unknown;
  channel?: unknown;
  agent?: unknown;
  value?: unknown;
  /** Explicit event time in epoch ms; defaults to the injected `now()` when absent. */
  occurredAtMs?: unknown;
  metadata?: Record<string, unknown>;
}

/** Trim + lowercase an attribution dimension; blank collapses to its unattributed label. */
function normalizeKey(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? fallback : trimmed;
}

/**
 * Validate + normalize a raw inbound event into a {@link FunnelEvent}. The single ingest door for BOTH
 * surfaces. Throws on an unknown stage/surface, a non-positive value, or a missing workspace — a funnel
 * count is never zero or negative, and an un-scoped event has no home. Defaults: `surface=marketing`,
 * `value=1`, `channel=direct`, `agent=none`, `occurredAt=now()`.
 */
export function normalizeFunnelEvent(
  workspaceId: string,
  raw: RawFunnelEvent,
  now: () => number,
): FunnelEvent {
  const wid = workspaceId.trim();
  if (!wid) throw new Error("normalizeFunnelEvent: workspaceId is required");

  if (!isFunnelStage(raw.stage)) {
    throw new Error(`normalizeFunnelEvent: unknown stage '${String(raw.stage)}'`);
  }

  const surface = raw.surface === undefined ? "marketing" : raw.surface;
  if (!isFunnelSurface(surface)) {
    throw new Error(`normalizeFunnelEvent: unknown surface '${String(raw.surface)}'`);
  }

  const value = raw.value === undefined ? 1 : raw.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`normalizeFunnelEvent: value must be a positive number, got '${String(raw.value)}'`);
  }

  const occurredAtMs = typeof raw.occurredAtMs === "number" ? raw.occurredAtMs : now();

  return {
    workspaceId: wid,
    stage: raw.stage,
    surface,
    channel: normalizeKey(raw.channel, UNATTRIBUTED_CHANNEL),
    agent: normalizeKey(raw.agent, UNATTRIBUTED_AGENT),
    value,
    occurredAt: new Date(occurredAtMs),
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
  };
}
