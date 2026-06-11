/**
 * The offline governed-value fixture (#155). The deterministic resolver the CI eval gate + the unit corpus
 * test use, keyed off the catalog's `scope` so it matches the LIVE default resolver exactly: a
 * workspace-scoped metric resolves to a fresh `semantic_layer` value; a venture-scoped metric resolves to a
 * flagged `raw_data` fallback (there is no single governed workspace-level number). Because the suites, this
 * fixture, and the live resolver all key off the same `scope`, an offline 100% pass-rate is the same verdict
 * the server would give over an empty workspace — no fixture/reality drift.
 */

import { getMetric } from "../semantic/catalog.js";
import type { ResolvedMetric } from "../semantic/answer.js";

/** Resolve a metric the way the live default resolver does, but with a fixed value + clock (deterministic). */
export function offlineResolve(metricId: string, nowMs: number): ResolvedMetric {
  const def = getMetric(metricId);
  if (def?.scope === "workspace") {
    return { value: 50, asOfMs: nowMs - 60_000, path: "semantic_layer" };
  }
  return { value: null, asOfMs: null, path: "raw_data" };
}
