import type { ReachMetrics } from "./measure.js";
import { REACH_SIGNAL_KINDS, type ReachSignalKind, type ReachVariant } from "./types.js";

/**
 * Self-tune (#280 step 8). Pure + deterministic. Given the measured outcome of the batch just sent and the
 * config that produced it, decide the config for the NEXT batch: which value-prop angle to lead with, which
 * buying signals to prioritise in the ICP filter, and what hour to send. The rule is evidence-gated — a
 * lever only moves when a cell has at least `minSample` delivered messages behind it, so a single lucky
 * reply can't swing the strategy. Reply rate is the optimisation target (the cheapest real outcome to
 * accumulate; booked is rarer and feeds the founder-console tile separately).
 */

/** The knobs self-tune turns between batches. */
export interface ReachTuningConfig {
  /** The value-prop angle the first cadence touch leads with. */
  variant: ReachVariant;
  /** The ICP signal priority order (highest-intent first) — reorders which prospects we source/score up. */
  signalPriority: ReachSignalKind[];
  /** The UTC hour the batch sends at. */
  sendHourUtc: number;
}

/** The starting config before any learning: pain-led, default signal order, 15:00 UTC (mid-morning US). */
export const REACH_TUNING_DEFAULTS: ReachTuningConfig = {
  variant: "pain",
  signalPriority: [...REACH_SIGNAL_KINDS],
  sendHourUtc: 15,
};

export interface TuningReport {
  current: ReachTuningConfig;
  next: ReachTuningConfig;
  /** Human-readable explanation of each change (or why nothing moved). */
  changes: string[];
  basis: {
    /** Total delivered messages the decision was made on. */
    sampleSize: number;
    /** Per-cell delivered-message floor required to trust a rate. */
    minSample: number;
  };
}

const DEFAULT_MIN_SAMPLE = 10;

/**
 * Compute the next-batch config. Each lever is independent and evidence-gated; an un-moved lever keeps its
 * current value and records the reason. Never throws.
 */
export function tuneNextBatch(
  metrics: ReachMetrics,
  current: ReachTuningConfig,
  opts?: { minSample?: number },
): TuningReport {
  const minSample = opts?.minSample ?? DEFAULT_MIN_SAMPLE;
  const changes: string[] = [];

  // --- variant: lead with the angle that replied best (if any cell cleared the floor). ---
  let variant = current.variant;
  const variantWinner = metrics.byVariant
    .filter((v) => v.sent >= minSample)
    .sort((a, b) => b.replyRate - a.replyRate || a.variant.localeCompare(b.variant))[0];
  if (variantWinner && variantWinner.variant !== current.variant) {
    const currentCell = metrics.byVariant.find((v) => v.variant === current.variant);
    const currentRate = currentCell && currentCell.sent >= minSample ? currentCell.replyRate : -1;
    if (variantWinner.replyRate > currentRate) {
      variant = variantWinner.variant;
      changes.push(
        `lead angle ${current.variant} → ${variant} ` +
          `(${(variantWinner.replyRate * 100).toFixed(1)}% reply on ${variantWinner.sent} sent)`,
      );
    }
  }
  if (variant === current.variant) changes.push(`lead angle held at ${variant} (no angle cleared the sample floor with a higher reply rate)`);

  // --- send hour: send when replies actually land. ---
  let sendHourUtc = current.sendHourUtc;
  const hourWinner = metrics.byHour
    .filter((h) => h.sent >= minSample)
    .sort((a, b) => b.replyRate - a.replyRate || a.hourUtc - b.hourUtc)[0];
  if (hourWinner && hourWinner.hourUtc !== current.sendHourUtc) {
    sendHourUtc = hourWinner.hourUtc;
    changes.push(
      `send hour ${current.sendHourUtc}:00 → ${sendHourUtc}:00 UTC ` +
        `(${(hourWinner.replyRate * 100).toFixed(1)}% reply on ${hourWinner.sent} sent)`,
    );
  } else {
    changes.push(`send hour held at ${sendHourUtc}:00 UTC`);
  }

  // --- signal priority: float the signals that replied best to the front, keep the rest in order. ---
  const ranked = metrics.bySignalKind
    .filter((s) => s.sent >= minSample && s.replyRate > 0)
    .sort((a, b) => b.replyRate - a.replyRate || a.signalKind.localeCompare(b.signalKind))
    .map((s) => s.signalKind);
  let signalPriority = current.signalPriority;
  if (ranked.length > 0) {
    const front = ranked.filter((k) => current.signalPriority.includes(k));
    const rest = current.signalPriority.filter((k) => !front.includes(k));
    const reordered = [...front, ...rest];
    if (reordered.join(",") !== current.signalPriority.join(",")) {
      signalPriority = reordered;
      changes.push(`signal priority promoted: ${front.join(", ")}`);
    } else {
      changes.push("signal priority unchanged (best-replying signals already lead)");
    }
  } else {
    changes.push("signal priority held (not enough per-signal data)");
  }

  return {
    current,
    next: { variant, signalPriority, sendHourUtc },
    changes,
    basis: { sampleSize: metrics.sent, minSample },
  };
}
