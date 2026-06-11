/**
 * Metric answer assembly + brand-voice rendering (#155, ADR-0155 §2–3). **Pure**. Given a metric
 * definition, a resolved value (or none), and the clock, produce a {@link MetricAnswer} carrying the
 * number, its provenance path, and freshness — then render it as a house-voice line. The house voice is
 * the Innocent-school fleet voice (warm, plural, receipts over adjectives): "made by robots, steered by
 * humans." A fallback or stale answer says so out loud — no quiet guessing.
 */

import type { MetricDefinition, MetricUnit } from "./catalog.js";
import {
  computeFreshness,
  formatAge,
  isFallbackPath,
  PATH_LABEL,
  type AnswerPath,
  type Freshness,
} from "./provenance.js";

/** What the resolver hands back for a metric: the number + when the underlying data was as-of. */
export interface ResolvedMetric {
  /** The canonical value, or null when there is no governed number (forces a flagged raw fallback). */
  value: number | null;
  /** Epoch ms the underlying data is as-of, or null when unknown/empty. */
  asOfMs: number | null;
  /** The path this number came through. `semantic_layer` when a governed scorer produced it. */
  path: AnswerPath;
}

/** A fully-assembled metric answer: the number, where it came from, how fresh, and the spoken line. */
export interface MetricAnswer {
  metricId: string;
  label: string;
  value: number | null;
  unit: MetricUnit;
  path: AnswerPath;
  /** True when the path is below the canonical semantic layer (the answer is a flagged fallback). */
  fallback: boolean;
  freshness: Freshness;
  /** The brand-voice line a human reads — value + provenance + freshness, fallback/staleness flagged. */
  spoken: string;
}

/** Format a raw value per its unit. Null renders as a dash. */
export function renderValue(value: number | null, unit: MetricUnit): string {
  if (value === null) return "—";
  switch (unit) {
    case "score_0_100":
      return `${round(value, 1)}/100`;
    case "score_0_10":
      return `${round(value, 1)}/10`;
    case "rate_0_1":
      return `${round(value * 100, 1)}%`;
    case "cents":
      // toFixed(2) so cents keep both decimal places ($1.50, not $1.5).
      return `$${(value / 100).toFixed(2)}`;
    case "count":
    default:
      return String(Math.round(value));
  }
}

/**
 * Assemble + render an answer. `maxAgeMs` is the freshness ceiling (from caps). The spoken line always
 * cites the provenance path and freshness; a fallback path adds an explicit "(fallback — verify)" flag and
 * a stale reading adds "(stale)". When the value is null we say we have no governed number rather than
 * inventing one.
 */
export function buildAnswer(
  def: MetricDefinition,
  resolved: ResolvedMetric,
  nowMs: number,
  maxAgeMs: number,
): MetricAnswer {
  const freshness = computeFreshness(resolved.asOfMs, nowMs, maxAgeMs);
  const fallback = isFallbackPath(resolved.path);
  const valueStr = renderValue(resolved.value, def.unit);

  const flags: string[] = [`via ${PATH_LABEL[resolved.path]}`, formatAge(freshness.ageMs)];
  if (freshness.stale) flags.push("stale — pull fresh before quoting");
  if (fallback) flags.push("fallback path — not the canonical number, verify before trusting");

  const head =
    resolved.value === null
      ? `No governed number for ${def.label} yet — nothing's flowed into ${def.source} for this workspace.`
      : `${def.label}: ${valueStr}.`;

  const spoken = `${head} (${flags.join("; ")}) made by robots, steered by humans.`;

  return {
    metricId: def.id,
    label: def.label,
    value: resolved.value,
    unit: def.unit,
    path: resolved.path,
    fallback,
    freshness,
    spoken,
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
