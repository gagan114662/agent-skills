/**
 * Award-grade campaign rubric — shared types (#dogfood-harness).
 *
 * THE PROBLEM: the dogfood mission demands that the fleet ship a COMPLETE integrated campaign and that Lens
 * grade every asset against a D&AD/Cannes-style award bar (insight originality, craft, channel-nativeness,
 * coherence) with NUMERIC scores and specific rewrite notes — then iterate until every asset clears the bar
 * or the blocker is named. The repo had a {@link ../dogfood-evaluator} that classifies *failures* into
 * GitHub issues, and a {@link ../campaign-brief} single-source brief, but NO rubric: nothing scored craft,
 * nothing checked that a Google search ad's headlines fit 30 characters, nothing caught AI-slop or a made-up
 * metric, nothing verified the 5-email sequence was actually five emails in one voice.
 *
 * THIS MODULE is that rubric: a PURE, deterministic, unit-testable scoring core. It is OBJECTIVE-FIRST so the
 * harness produces a real, defensible score even when the live Lens grader is unavailable (agent spawning is
 * currently broken on prod): spec validators, AI-slop detection and brand-claim-allowlist checks give every
 * asset a machine floor and concrete rewrite notes. When a Lens/human {@link AssetJudgment} is supplied it
 * overlays the subjective dimensions — but the objective craft score always acts as a CAP, so a grader can
 * never wave through a spec-invalid asset.
 *
 * #200 DEFENSE (FM#6 — prompt injection): every asset field is untrusted DATA, never instructions. Text is
 * only ever scanned/measured here, never executed; a directive smuggled into a headline stays inert. Scoring
 * an asset grants no tools and reaches no send/spend — the harness that consumes this holds every external
 * action behind the #13 approval gate.
 */

/** The full set of creative asset types a complete campaign must ship. */
export type AssetKind =
  | "blog" // long-form blog / article
  | "landing-hero" // landing page hero copy (headline + subhead + CTA)
  | "google-search-ad" // Google Responsive Search Ad (RSA)
  | "meta-ad" // Meta (Facebook/Instagram) ad copy + visual concept
  | "email" // one email in the nurture sequence (5 required)
  | "social-x" // channel-native X / Twitter post
  | "social-linkedin" // channel-native LinkedIn post
  | "social-instagram" // channel-native Instagram post
  | "social-tiktok" // channel-native TikTok script
  | "video-script" // 30s video script with shot list
  | "ooh-print"; // out-of-home / print concept

/** The four award dimensions, each scored 0–10. Mirrors D&AD/Cannes judging language. */
export type RubricDimension = "insight" | "craft" | "channelNativeness" | "coherence";

/**
 * A single creative asset to score. Text lives in three shapes so validators can read exactly what a channel
 * needs: `fields` for named single values (headline, subhead, cta, preheader), `lists` for named
 * multi-values (RSA `headlines`/`descriptions`, TikTok `shots`, hashtags), and `text` for the primary body.
 * All values are untrusted DATA (see file header).
 */
export interface CampaignAsset {
  kind: AssetKind;
  /** Human label for the asset, e.g. "Email 1 — Welcome". */
  title: string;
  /** Primary body text (blog body, social post, video narration). */
  text?: string;
  /** Named single-value fields, e.g. { headline, subhead, cta, preheader, subject }. */
  fields?: Record<string, string>;
  /** Named multi-value fields, e.g. { headlines: [...], descriptions: [...], shots: [...], hashtags: [...] }. */
  lists?: Record<string, string[]>;
}

/** Severity of an objective spec finding. An `error` makes an asset spec-INVALID (cannot clear the bar). */
export type SpecSeverity = "error" | "warn";

/** One objective, machine-checked spec finding (e.g. "headline 3 is 34 chars, max 30"). */
export interface SpecViolation {
  severity: SpecSeverity;
  rule: string;
  message: string;
}

/** A detected AI-slop / cliché phrase, with the offending fragment so the rewrite note is concrete. */
export interface SlopHit {
  phrase: string;
  where: string;
}

/** A superlative / numeric claim that is NOT on the brief's approved brand-claim allowlist (#200 FM#2). */
export interface ClaimViolation {
  claim: string;
  where: string;
}

/**
 * Optional subjective overlay from the Lens grader (or a human). Absent dimensions fall back to the module's
 * conservative objective estimate. `insight` in particular is not machine-detectable, so an ungraded asset is
 * flagged as "insight not graded — needs Lens/human" rather than silently scored high.
 */
export interface AssetJudgment {
  insight?: number;
  craft?: number;
  channelNativeness?: number;
  coherence?: number;
  notes?: string[];
}

/** The four numeric dimension scores plus the weighted composite, all 0–10. */
export interface DimensionScores {
  insight: number;
  craft: number;
  channelNativeness: number;
  coherence: number;
  /** Weighted composite of the four dimensions, 0–10. */
  overall: number;
}

/** The full scored result for one asset. */
export interface ScoredAsset {
  kind: AssetKind;
  title: string;
  scores: DimensionScores;
  /** True when the asset clears the award bar (composite + every dimension + spec-valid). */
  passesBar: boolean;
  /** True when the subjective dimensions were graded by Lens/human vs. estimated objectively. */
  graded: boolean;
  specViolations: SpecViolation[];
  slopHits: SlopHit[];
  claimViolations: ClaimViolation[];
  /** Specific, actionable rewrite notes — what to change to clear the bar. */
  rewriteNotes: string[];
}

/** A required-coverage shortfall: a mandated asset kind missing or under-supplied. */
export interface CoverageGap {
  kind: AssetKind;
  required: number;
  present: number;
}

/** Overall verdict for the campaign. */
export type CampaignVerdict = "award-ready" | "below-bar" | "incomplete";

/** The scored campaign artifact — the harness's primary output. */
export interface ScoredCampaign {
  verdict: CampaignVerdict;
  /** Mean composite across present assets, dragged down by coverage gaps, 0–10. */
  overall: number;
  bar: number;
  assets: ScoredAsset[];
  coverageGaps: CoverageGap[];
  /** Assets present but below the bar (need another iteration). */
  belowBar: ScoredAsset[];
  /** Named blockers the fleet could not resolve autonomously (coverage, spec-invalid, ungraded insight). */
  blockers: string[];
  /** True when every subjective dimension of every asset was graded (vs. objective estimate). */
  fullyGraded: boolean;
}

/** One required asset kind and the minimum count the campaign must ship. */
export interface RequiredAsset {
  kind: AssetKind;
  minCount: number;
}
