import { MARKETING_DEPARTMENTS } from "../marketing/blueprint.js";

/**
 * The per-department PROOF scorecard (#253) — a **pure** roll-up that answers the owner's real question:
 * not "how many drafts are queued" but "what real work has each department shipped on ipop.ai?". Each of
 * the seven marketing departments (Scout/SEO, Quill/Content, Echo/Social, Postmark/Email, Bid/Ads,
 * Lens/Analytics, Mark/Brand) gets one tile carrying a single sourced outcome metric + its trend.
 *
 * The honesty contract (premortem #200 §2): a tile is `connected` ONLY when a real source is wired and the
 * number is grounded in it (published artifacts, external send receipts, growth events). Where a source
 * isn't wired yet (Search Console positions, the brand-asset store) the tile renders `not_connected` with
 * the reason — it NEVER shows a fabricated or draft-only count. The reader (default.ts) supplies the real
 * readings; this module is pure so it unit-tests without a DB and always emits all seven tiles (so the
 * console renders the full scorecard — mostly "not connected" — before any source is wired).
 */

/** Whether a real source backs the tile. `not_connected` ⇒ no fabricated number is shown. */
export type ProofConnection = "connected" | "not_connected";

/** Direction the metric moved vs the prior trend window. `none` ⇒ no comparison was wired. */
export type ProofTrend = "up" | "down" | "flat" | "none";

/** How to format a value: a raw count, money (cents), or a basis-points ratio. */
export type ProofUnit = "count" | "currency" | "ratio_bps";

/** What kind of evidence backs a metric. External customer proof requires a receipt. */
export type ProofEvidenceKind = "live" | "sample" | "dogfood" | "external_customer_proof";

/** A real customer receipt that allows a tile to claim external customer proof. */
export type ProofReceiptKind = "signup" | "payment" | "reply" | "call_booked" | "customer_approval";

export interface ProofReceipt {
  kind: ProofReceiptKind;
  ref: string;
}

/**
 * One department's real reading, supplied by the wiring (default.ts). A reading with `connected: false`
 * (or a `null` current) renders a "not connected" tile — but still carries the `source`/`note` so the
 * owner sees WHY it isn't wired (e.g. "Search Console not connected").
 */
export interface ProofMetricReading {
  /** Must match a {@link MARKETING_DEPARTMENTS} key (seo|content|social|email|ads|analytics|brand). */
  department: string;
  /** Whether a real source is wired. false ⇒ tile is "not connected" regardless of `current`. */
  connected: boolean;
  /** Current (typically cumulative) value in the tile's unit. null ⇒ "not connected". */
  current: number | null;
  /** The value one trend-window ago (for the delta). null/absent ⇒ trend "none". */
  prior?: number | null;
  unit: ProofUnit;
  /** What the tile proves, overriding the department default (e.g. "Articles live on the blog"). */
  metricLabel?: string;
  /** Where the number came from, or why it's missing (e.g. "Published artifacts (#231)"). */
  source?: string;
  /** A caveat when the source is partial (e.g. "impressions not connected"). */
  note?: string;
  /** Labels whether this is live system data, sample/demo, dogfood, or external customer proof. */
  evidenceKind?: ProofEvidenceKind;
  /** Required when evidenceKind is external_customer_proof. */
  receipt?: ProofReceipt | null;
  /** Lower-is-better metrics (CAC) set this false so a falling value reads as an improvement. Default true. */
  higherIsBetter?: boolean;
}

/** One rendered tile — everything the console needs to draw a department's proof at a glance. */
export interface ProofTile {
  department: string;
  /** The named agent (e.g. "Scout"). */
  agent: string;
  /** The department title (e.g. "SEO"). */
  title: string;
  /** What real outcome this tile proves. */
  metricLabel: string;
  connection: ProofConnection;
  unit: ProofUnit;
  /** Current value; null when not connected. */
  value: number | null;
  /** Pre-formatted current value, or the not-connected copy. */
  display: string;
  trend: ProofTrend;
  /** Signed delta vs the prior window; null when there's no comparison. */
  delta: number | null;
  /** Whether the trend is an improvement (honours `higherIsBetter`); null when trend is none. */
  improving: boolean | null;
  /** Short, formatted delta caption (e.g. "+3", "−$1.20", "no change", "—"). */
  trendDetail: string;
  /** Where the number is sourced, or the reason it isn't wired. */
  source: string;
  /** Partial-source caveat, or null. */
  note: string | null;
  /** Labels whether this is live system data, sample/demo, dogfood, or external customer proof. */
  evidenceKind: ProofEvidenceKind;
  /** The customer receipt backing external_customer_proof; null for other evidence kinds. */
  receipt: ProofReceipt | null;
}

/** The whole scorecard: one tile per department + a connected/total tally. */
export interface ProofScorecard {
  tiles: ProofTile[];
  /** Departments with a real wired source proving outcomes. */
  connectedCount: number;
  /** Total departments (always {@link MARKETING_DEPARTMENTS}.length). */
  total: number;
}

/**
 * What each department PROVES — the default tile label when the reader doesn't override it. These mirror the
 * owner's bar verbatim (issue #253): real outcomes on ipop.ai, not draft counts.
 */
const DEFAULT_METRIC_LABEL: Record<string, string> = {
  seo: "Indexed pages + target-keyword positions",
  content: "Articles live on the blog",
  social: "Posts live + impressions",
  email: "Emails sent + open / click",
  ads: "Campaign clicks + CAC",
  analytics: "Sessions · signups · trial conversions",
  brand: "Brand assets live",
  reach: "Prospects reached · replies · meetings",
};

const NOT_CONNECTED_DISPLAY = "not connected";

function evidenceKind(reading: ProofMetricReading | undefined): ProofEvidenceKind {
  return reading?.evidenceKind ?? "live";
}

function receipt(reading: ProofMetricReading | undefined): ProofReceipt | null {
  const r = reading?.receipt ?? null;
  if (!r || r.ref.trim().length === 0) return null;
  return r;
}

function formatValue(unit: ProofUnit, value: number): string {
  switch (unit) {
    case "currency":
      return `$${(value / 100).toFixed(2)}`;
    case "ratio_bps":
      return `${(value / 100).toFixed(1)}%`;
    case "count":
    default:
      return String(value);
  }
}

/** Format a signed delta with its sign glyph (− for negative, + for positive), in the tile's unit. */
function formatDelta(unit: ProofUnit, delta: number): string {
  if (delta === 0) return "no change";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatValue(unit, Math.abs(delta))}`;
}

function buildTile(
  dept: (typeof MARKETING_DEPARTMENTS)[number],
  reading: ProofMetricReading | undefined,
): ProofTile {
  const metricLabel = reading?.metricLabel ?? DEFAULT_METRIC_LABEL[dept.key] ?? dept.title;
  const kind = evidenceKind(reading);
  const externalReceipt = receipt(reading);
  const base = {
    department: dept.key,
    agent: dept.agent.displayName,
    title: dept.title,
    metricLabel,
  };

  if (reading?.connected && reading.current !== null && kind === "external_customer_proof" && !externalReceipt) {
    return {
      ...base,
      connection: "not_connected",
      unit: reading.unit,
      value: null,
      display: NOT_CONNECTED_DISPLAY,
      trend: "none",
      delta: null,
      improving: null,
      trendDetail: "—",
      source: "External customer proof missing receipt",
      note: "requires signup, payment, reply, call booked, or customer approval receipt",
      evidenceKind: kind,
      receipt: null,
    };
  }

  // Not connected: no source wired (or no reading at all). We surface the WHY (source/note) but never a number.
  if (!reading || !reading.connected || reading.current === null) {
    return {
      ...base,
      connection: "not_connected",
      unit: reading?.unit ?? "count",
      value: null,
      display: NOT_CONNECTED_DISPLAY,
      trend: "none",
      delta: null,
      improving: null,
      trendDetail: "—",
      source: reading?.source ?? "not connected",
      note: reading?.note ?? null,
      evidenceKind: kind,
      receipt: externalReceipt,
    };
  }

  const current = reading.current;
  const prior = reading.prior ?? null;
  let trend: ProofTrend = "none";
  let delta: number | null = null;
  let improving: boolean | null = null;
  let trendDetail = "—";
  if (prior !== null) {
    delta = current - prior;
    const higherIsBetter = reading.higherIsBetter ?? true;
    trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    improving = delta === 0 ? null : delta > 0 === higherIsBetter;
    trendDetail = formatDelta(reading.unit, delta);
  }

  return {
    ...base,
    connection: "connected",
    unit: reading.unit,
    value: current,
    display: formatValue(reading.unit, current),
    trend,
    delta,
    improving,
    trendDetail,
    source: reading.source ?? "connected",
    note: reading.note ?? null,
    evidenceKind: kind,
    receipt: externalReceipt,
  };
}

/**
 * Build the seven-tile proof scorecard from the supplied real readings. Deterministic + pure. Always emits
 * one tile per {@link MARKETING_DEPARTMENTS} entry in canonical order; a department with no reading (or a
 * `connected: false` reading) renders "not connected" rather than a fabricated number.
 */
export function buildProofScorecard(input: { readings?: ProofMetricReading[] }): ProofScorecard {
  const byDept = new Map((input.readings ?? []).map((r) => [r.department, r]));
  const tiles = MARKETING_DEPARTMENTS.map((dept) => buildTile(dept, byDept.get(dept.key)));
  return {
    tiles,
    connectedCount: tiles.filter((t) => t.connection === "connected").length,
    total: tiles.length,
  };
}
