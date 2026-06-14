/**
 * Customer Discovery Engine — the STABLE consumer contract (#222, ADR-0222).
 *
 * This is the single import site the decision-maker resolver (#223) and the outreach engine (#225) use to
 * consume the discovery layer's output WITHOUT depending on its internals. The discovery engine is
 * READ-ONLY: it ranks and surfaces; it never sends. Two artifacts make up the contract:
 *
 *   1. {@link DiscoveryQueue} — the daily ranked "who to reach out to now" queue. Each
 *      {@link DiscoveryProspect} row carries its qualifying definition(s) + signal kind(s) and a 0–100
 *      conversion-likelihood `score`. The score is ALWAYS a prediction: `scoreVerified` is `false` and
 *      `likelihoodLabel` is `"UNVERIFIED"` until an external receipt confirms a conversion (premortem
 *      #200 §2). Consume `queue` / `topProspects` and never re-derive a score yourself.
 *
 *   2. {@link PqlEventRecord} — the PQL (product-qualified-lead) event stream. One event fires the moment
 *      a prospect's real signals satisfy an owner-defined definition. `verified` is `true` only when an
 *      externally-attributed conversion grounded it. Consume `listPqlEvents` to react to qualifications.
 *
 * The 5-stage GTM pipeline ({@link GtmPipelineSummary}) is the funnel view the founder console reads.
 *
 * Stability promise: these shapes are additive-only. New fields may appear; existing fields keep their
 * meaning. A consumer should treat unknown fields as ignorable and never assume a score is verified.
 */
export type {
  DiscoveryProspect,
  DiscoveryDefKind,
  DiscoverySignalKind,
  DefMatch,
  GtmStage,
  GtmPipelineMetrics,
  PipelineStageMetric,
  StageConversion,
} from "./score.js";
export { UNVERIFIED_LABEL } from "./score.js";

export type {
  DiscoveryQueue,
  GtmPipelineSummary,
} from "./service.js";

export type {
  PqlEventRecord,
  SignalDefRecord,
  DiscoverySignalRecord,
  PipelineEntryRecord,
} from "./types.js";
