import type { DemandSignalClass } from "./provenance.js";
import type { Funnel } from "./signals.js";

/**
 * Experiment registry evaluation (#101) — the anti-p-hacking gate. **Pure**: given a **locked**
 * {@link ExperimentSpec} (hypothesis + success/denominator class + pass-threshold + min-sample + window)
 * and the observed {@link Funnel}, decide PASS / FAIL / INCONCLUSIVE / PENDING. The bar is read from the
 * spec, **never** from the observed data, so the goalposts cannot move after the numbers come in.
 *
 * Two anti-p-hacking rails are structural:
 *  - **No optional stopping:** a terminal verdict is only reached after the sample window closes — a lucky
 *    early run stays PENDING, it cannot be cashed in.
 *  - **No tiny-sample wins:** below the locked `minSample` after the window closes is INCONCLUSIVE, never
 *    PASS — you cannot declare victory on three visitors.
 */
export interface ExperimentSpec {
  hypothesis: string;
  /** The success funnel stage (e.g. `paid`). */
  successClass: DemandSignalClass;
  /** The denominator funnel stage the conversion is measured against (e.g. `visit`). */
  denominatorClass: DemandSignalClass;
  /** Pass bar: conversion `successClass / denominatorClass` must reach this rate (0..1]. */
  passThreshold: number;
  /** Minimum denominator-stage count required for a terminal PASS/FAIL (else INCONCLUSIVE). */
  minSample: number;
  windowStartMs: number;
  windowEndMs: number;
}

export type ExperimentStatus = "PENDING" | "PASS" | "FAIL" | "INCONCLUSIVE";

export interface ExperimentEvaluation {
  status: ExperimentStatus;
  conversion: number;
  successCount: number;
  denominatorCount: number;
  sampleMet: boolean;
  windowClosed: boolean;
  reasoning: string;
}

/** Thrown when a spec's bar/window is malformed — the registry refuses to lock it (route → 400). */
export class ExperimentSpecError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ExperimentSpecError";
  }
}

/** Validate a spec before it is locked at registration. Throws {@link ExperimentSpecError} when invalid. */
export function validateSpec(spec: ExperimentSpec): void {
  if (!(spec.passThreshold > 0 && spec.passThreshold <= 1)) {
    throw new ExperimentSpecError("passThreshold must be in (0, 1]");
  }
  if (!Number.isFinite(spec.minSample) || spec.minSample < 1) {
    throw new ExperimentSpecError("minSample must be a positive integer");
  }
  if (!(spec.windowEndMs > spec.windowStartMs)) {
    throw new ExperimentSpecError("windowEndMs must be after windowStartMs");
  }
  if (!spec.hypothesis.trim()) {
    throw new ExperimentSpecError("hypothesis is required");
  }
}

/**
 * Evaluate the locked spec against the observed funnel at `nowMs`. While the window is open the verdict is
 * PENDING (no optional stopping); once it closes, a met sample yields PASS/FAIL on the locked threshold and
 * an unmet sample yields INCONCLUSIVE.
 */
export function evaluateExperiment(
  spec: ExperimentSpec,
  funnel: Funnel,
  nowMs: number,
): ExperimentEvaluation {
  const successCount = funnel.counts[spec.successClass];
  const denominatorCount = funnel.counts[spec.denominatorClass];
  const conversion = denominatorCount > 0 ? successCount / denominatorCount : 0;
  const sampleMet = denominatorCount >= spec.minSample;
  const windowClosed = nowMs >= spec.windowEndMs;

  const base = { conversion, successCount, denominatorCount, sampleMet, windowClosed };

  if (!windowClosed) {
    return {
      ...base,
      status: "PENDING",
      reasoning: `window open — collecting (${denominatorCount}/${spec.minSample} sample; no early stopping)`,
    };
  }
  if (!sampleMet) {
    return {
      ...base,
      status: "INCONCLUSIVE",
      reasoning: `window closed with ${denominatorCount} < ${spec.minSample} sample — inconclusive (no tiny-sample wins)`,
    };
  }
  if (conversion >= spec.passThreshold) {
    return {
      ...base,
      status: "PASS",
      reasoning: `conversion ${conversion.toFixed(4)} ≥ locked bar ${spec.passThreshold} over ${denominatorCount} sample`,
    };
  }
  return {
    ...base,
    status: "FAIL",
    reasoning: `conversion ${conversion.toFixed(4)} < locked bar ${spec.passThreshold} over ${denominatorCount} sample`,
  };
}
