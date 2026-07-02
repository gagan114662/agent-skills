/**
 * The award-grade rubric core (#dogfood-harness). Pure and deterministic — the same inputs always produce the
 * same scores, so a test can assert the bar and the harness can re-run reproducibly.
 *
 * SCORING MODEL (objective-first). Four dimensions, each 0–10, weighted into a composite:
 *   - insight (0.30)            — originality of the idea. NOT machine-detectable; needs a Lens/human grade.
 *   - craft (0.30)             — execution quality. Objective floor from spec errors + AI-slop; a Lens grade
 *                                 may only LOWER it (objective craft is a hard CAP — see {@link scoreAsset}).
 *   - channelNativeness (0.20) — does the asset exploit its channel's native form (spec-driven).
 *   - coherence (0.20)         — one voice / no invented claims (brand-claim allowlist + slop).
 *
 * BAR: an asset is "award-ready" only when it is graded by Lens, its composite ≥ 8.0, every dimension ≥ 7.0,
 * and it has no spec ERROR. Ungraded assets can never be certified — which is the honest state while the Lens
 * grader (an agent) is unavailable on prod: the harness reports them as blocked, not as passing.
 */
import { validateAsset } from "./spec.js";
import { detectSlop, detectUnapprovedClaims } from "./voice.js";
import type {
  AssetJudgment,
  CampaignAsset,
  CoverageGap,
  DimensionScores,
  RequiredAsset,
  RubricDimension,
  ScoredAsset,
  ScoredCampaign,
} from "./types.js";

/** Dimension weights; sum to 1. */
export const DIMENSION_WEIGHTS: Record<RubricDimension, number> = {
  insight: 0.3,
  craft: 0.3,
  channelNativeness: 0.2,
  coherence: 0.2,
};

/** Composite score an asset must reach to clear the award bar. */
export const AWARD_BAR = 8.0;
/** Minimum any single dimension may score for an asset to clear the bar. */
export const DIMENSION_MIN = 7.0;

/** The canonical definition of a COMPLETE campaign: every kind the fleet must ship, and how many. */
export const REQUIRED_ASSETS: readonly RequiredAsset[] = [
  { kind: "blog", minCount: 1 },
  { kind: "landing-hero", minCount: 1 },
  { kind: "google-search-ad", minCount: 1 },
  { kind: "meta-ad", minCount: 1 },
  { kind: "email", minCount: 5 },
  { kind: "social-x", minCount: 1 },
  { kind: "social-linkedin", minCount: 1 },
  { kind: "social-instagram", minCount: 1 },
  { kind: "social-tiktok", minCount: 1 },
  { kind: "video-script", minCount: 1 },
  { kind: "ooh-print", minCount: 1 },
];

const clamp = (n: number): number => Math.max(0, Math.min(10, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Context a single asset is scored against. */
export interface ScoreContext {
  /** The brief's approved brand claims — the allowlist for #200 FM#2 claim checking. */
  approvedClaims: readonly string[];
}

function weightedOverall(d: Omit<DimensionScores, "overall">): number {
  return round1(
    d.insight * DIMENSION_WEIGHTS.insight +
      d.craft * DIMENSION_WEIGHTS.craft +
      d.channelNativeness * DIMENSION_WEIGHTS.channelNativeness +
      d.coherence * DIMENSION_WEIGHTS.coherence,
  );
}

/**
 * Score one asset. Objective signals (spec, slop, claims) set floors/caps; an optional Lens/human
 * {@link AssetJudgment} overlays the subjective dimensions. Craft is special: a supplied craft grade is
 * capped by the objective craft, so a grader can never rescue a spec-invalid or slop-ridden asset.
 */
export function scoreAsset(asset: CampaignAsset, ctx: ScoreContext, judgment?: AssetJudgment): ScoredAsset {
  const specViolations = validateAsset(asset);
  const slopHits = detectSlop(asset);
  const claimViolations = detectUnapprovedClaims(asset, ctx.approvedClaims);

  const errors = specViolations.filter((v) => v.severity === "error").length;
  const warns = specViolations.filter((v) => v.severity === "warn").length;

  // Objective estimates.
  const craftObjective = clamp(10 - errors * 3.5 - warns * 0.8 - slopHits.length * 1.5);
  const channelObjective = clamp(9 - errors * 3 - warns * 1);
  const coherenceObjective = clamp(9 - claimViolations.length * 2.5 - slopHits.length * 1);
  const insightObjective = 5; // neutral — insight is not machine-detectable.

  const graded = judgment?.insight !== undefined;

  const dims: Omit<DimensionScores, "overall"> = {
    insight: round1(judgment?.insight ?? insightObjective),
    craft: round1(judgment?.craft !== undefined ? Math.min(judgment.craft, craftObjective) : craftObjective),
    channelNativeness: round1(judgment?.channelNativeness ?? channelObjective),
    coherence: round1(judgment?.coherence ?? coherenceObjective),
  };
  const scores: DimensionScores = { ...dims, overall: weightedOverall(dims) };

  const passesBar =
    graded &&
    errors === 0 &&
    scores.overall >= AWARD_BAR &&
    dims.insight >= DIMENSION_MIN &&
    dims.craft >= DIMENSION_MIN &&
    dims.channelNativeness >= DIMENSION_MIN &&
    dims.coherence >= DIMENSION_MIN;

  const rewriteNotes: string[] = [];
  for (const v of specViolations) rewriteNotes.push(`[spec:${v.severity}] ${v.message}`);
  for (const s of slopHits) rewriteNotes.push(`[voice] Replace AI-slop phrase "${s.phrase}" with something specific and human.`);
  for (const c of claimViolations)
    rewriteNotes.push(`[claim] "${c.claim}" is not in the approved brand-claim allowlist — cut it or add it to the brief (#200: no invented metrics).`);
  if (!graded) rewriteNotes.push("[grade] Insight not graded by Lens — award certification requires a Lens/human grade.");
  for (const n of judgment?.notes ?? []) rewriteNotes.push(`[lens] ${n}`);

  return { kind: asset.kind, title: asset.title, scores, passesBar, graded, specViolations, slopHits, claimViolations, rewriteNotes };
}

/** Options for scoring a whole campaign. */
export interface CampaignScoreOptions {
  requiredAssets?: readonly RequiredAsset[];
  /** Per-asset Lens/human judgments, indexed to the `assets` array by position. */
  judgments?: ReadonlyArray<AssetJudgment | undefined>;
}

function computeCoverage(assets: readonly CampaignAsset[], required: readonly RequiredAsset[]): CoverageGap[] {
  const counts = new Map<string, number>();
  for (const a of assets) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const gaps: CoverageGap[] = [];
  for (const req of required) {
    const present = counts.get(req.kind) ?? 0;
    if (present < req.minCount) gaps.push({ kind: req.kind, required: req.minCount, present });
  }
  return gaps;
}

/**
 * Score a full campaign against the brief. Produces the scored artifact the harness emits: per-asset scores,
 * coverage gaps, the below-bar set to iterate on, an overall (dragged down by missing coverage), and the
 * named blockers a human/Lens must resolve. Deterministic.
 */
export function scoreCampaign(
  brief: { brandClaims: readonly string[] },
  assets: readonly CampaignAsset[],
  opts: CampaignScoreOptions = {},
): ScoredCampaign {
  const required = opts.requiredAssets ?? REQUIRED_ASSETS;
  const ctx: ScoreContext = { approvedClaims: brief.brandClaims };
  const scored = assets.map((a, i) => scoreAsset(a, ctx, opts.judgments?.[i]));

  const coverageGaps = computeCoverage(assets, required);
  const belowBar = scored.filter((s) => !s.passesBar);
  const fullyGraded = scored.length > 0 && scored.every((s) => s.graded);

  const meanOverall = scored.length ? scored.reduce((sum, s) => sum + s.scores.overall, 0) / scored.length : 0;
  const coverageRatio = required.length ? (required.length - coverageGaps.length) / required.length : 1;
  const overall = round1(meanOverall * coverageRatio);

  const blockers: string[] = [];
  for (const g of coverageGaps) blockers.push(`Missing required asset: ${g.kind} (need ${g.required}, have ${g.present}).`);
  for (const s of scored) {
    const specErr = s.specViolations.find((v) => v.severity === "error");
    if (specErr) blockers.push(`Spec-invalid: "${s.title}" — ${specErr.message}`);
  }
  const ungraded = scored.filter((s) => !s.graded).length;
  if (ungraded > 0)
    blockers.push(`${ungraded}/${scored.length} assets ungraded — Lens grader unavailable (agent spawning blocked on prod).`);

  const verdict = coverageGaps.length > 0 ? "incomplete" : belowBar.length === 0 ? "award-ready" : "below-bar";

  return { verdict, overall, bar: AWARD_BAR, assets: scored, coverageGaps, belowBar, blockers, fullyGraded };
}
