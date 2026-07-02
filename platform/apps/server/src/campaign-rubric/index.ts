/**
 * Award-grade campaign rubric (#dogfood-harness) — public surface. See {@link ./types} for the model and
 * {@link ./rubric} for the scoring core. Pure and deterministic throughout.
 */
export * from "./types.js";
export { SPEC, validateAsset, assetCorpus } from "./spec.js";
export { SLOP_PHRASES, detectSlop, detectUnapprovedClaims } from "./voice.js";
export {
  DIMENSION_WEIGHTS,
  AWARD_BAR,
  DIMENSION_MIN,
  REQUIRED_ASSETS,
  scoreAsset,
  scoreCampaign,
  type ScoreContext,
  type CampaignScoreOptions,
} from "./rubric.js";
export { renderScoredCampaign } from "./render.js";
export { deriveGapDrafts, type GapDraft } from "./gaps.js";
export { IPOP_LAUNCH_BRIEF, DEMO_CAMPAIGN_ASSETS } from "./brief-fixture.js";
