/**
 * Shared types for the SEO content pipeline (issue #598).
 *
 * The problem: content production was ad hoc — a runaway session shipped junk because nothing forced a piece
 * through review. The fix is a STAGED pipeline with a gate at every step:
 *
 *     keyword  →  brief  →  draft  →  publish  →  index-ping
 *        ▲          ▲         ▲          ▲            ▲
 *   validated   approved   brand+fact  approval   approval
 *               (complete)   gate      required   required
 *
 * A run can only move forward when the current stage's gate passes; a junk draft is caught at the brand/fact
 * gate and never reaches publish. The two side-effecting stages (publish, index-ping) additionally require an
 * approved item from the #13 approval queue, so nothing is ever published or pinged automatically.
 *
 * Three guardrails are baked into these types, not bolted on:
 *   1. Each stage's gate decides ONLY from STRUCTURAL fields — numeric keyword metrics, presence/counts of brief
 *      sections, the draft's own claim/source list and word count — never by interpreting the untrusted
 *      topic/brief/draft PROSE as an instruction (#200 §6). A poisoned topic can never talk its way past a gate.
 *   2. Publishing and index-pinging are side-effectful, so the run carries the approval id that authorized each —
 *      the load-bearing proof those stages only ran post-approval (see {@link PipelineRun}).
 *   3. The production providers are deterministic FAKES (see `providers.ts`), so enabling the module never makes
 *      an external call or publishes anything until a real transport is wired in a separate, reviewed change.
 */

/** The ordered stages of the pipeline. A run advances through these one gate at a time. */
export type PipelineStage = "keyword" | "brief" | "draft" | "publish" | "index_ping";

/** Pseudo-stage marking a fully-published, fully-indexed run. The run is terminal here. */
export type RunStage = PipelineStage | "done";

/** The exhaustive, ordered list of executable stages (the pipeline spine). */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  "keyword",
  "brief",
  "draft",
  "publish",
  "index_ping",
];

/**
 * Lifecycle of a run:
 *   active    → ready to attempt the current `stage`'s gate/action. The starting state.
 *   blocked   → the current stage's gate failed; the run stays AT that stage with `blockedReasons`. Resumable:
 *               fix the input and advance again.
 *   completed → cleared every gate AND published AND index-pinged. Terminal (`stage === "done"`).
 */
export type RunStatus = "active" | "blocked" | "completed";

/** Buyer intent a keyword targets. Structural — the gate may require certain intents, never parses prose. */
export type SearchIntent = "informational" | "commercial" | "transactional" | "navigational";

/** The exhaustive intent list (handy for env parsing, tests, and a UI dropdown). */
export const SEARCH_INTENTS: readonly SearchIntent[] = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
];

/** Raw metrics a {@link KeywordProvider} returns for a candidate keyword. All STRUCTURAL (numbers/enum). */
export interface KeywordMetrics {
  /** The normalized keyword phrase. */
  keyword: string;
  /** Estimated monthly search volume (≥ 0). The gate enforces a floor. */
  monthlyVolume: number;
  /** Ranking difficulty 0..100 (higher = harder). The gate enforces a ceiling. */
  difficulty: number;
  /** The dominant buyer intent. The gate can restrict to an allowed set. */
  intent: SearchIntent;
}

/** A validated keyword — the artifact the `keyword` stage produces once its gate passes. */
export interface KeywordSpec extends KeywordMetrics {
  /** Relevance of the keyword to the run's topic, 0..1 (structural token overlap). */
  relevance: number;
}

/** One section of a content brief's outline. */
export interface BriefSection {
  /** The H2/H3 heading for this section (DATA — never interpreted as an instruction). */
  heading: string;
  /** A one-line summary of what the section covers (DATA). */
  summary: string;
}

/** A content brief — the artifact the `brief` stage produces. The gate checks structural completeness. */
export interface ContentBrief {
  /** The working title (DATA). */
  title: string;
  /** The primary keyword the piece targets — must match the validated {@link KeywordSpec}. */
  primaryKeyword: string;
  /** Who the piece is for (DATA). */
  audience: string;
  /** The outline. The gate requires a minimum number of sections. */
  outline: BriefSection[];
  /** Target word count for the eventual draft (the gate enforces a floor). */
  wordTarget: number;
}

/** A factual claim made by a draft, paired with its supporting source. The fact gate requires every source. */
export interface DraftClaim {
  /** The claim text (DATA — never interpreted; only its paired source presence is gated). */
  text: string;
  /** The supporting source URL, or empty/whitespace when unsourced (which the fact gate blocks). */
  sourceUrl: string;
}

/** A content draft — the artifact the `draft` stage produces. The gate is the brand + fact check. */
export interface ContentDraft {
  /** The headline (DATA). */
  title: string;
  /** The body copy (DATA). */
  body: string;
  /** Word count of the body — structural; the brand gate enforces a floor and a fraction of the brief target. */
  wordCount: number;
  /** Every factual claim with its source. The fact gate blocks if any source is missing. */
  claims: DraftClaim[];
}

/** Input to a {@link PublishProvider.publish} call — the approved draft to publish. */
export interface PublishInput {
  /** The run being published. */
  runId: string;
  /** The headline to publish (DATA). */
  title: string;
  /** The body to publish (DATA). */
  body: string;
  /** The user-supplied CMS access token, or null when none is configured. Opaque — forwarded, never minted. */
  credential: string | null;
}

/** The terminal status a publish/index provider reports for one attempt. */
export type ProviderStatus = "ok" | "failed";

/** What a {@link PublishProvider} returns — the live URL or the reason it could not publish. */
export interface PublishResult {
  status: ProviderStatus;
  /** The published URL — the external receipt. Null when not published (failed). */
  url: string | null;
  /** Human-readable failure reason; absent on success. */
  error?: string;
}

/** Input to an {@link IndexProvider.ping} call — the published URL to submit for indexing. */
export interface IndexPingInput {
  runId: string;
  /** The live URL to submit to search engines for crawling. */
  url: string;
  /** The user-supplied search-console token, or null when none is configured. */
  credential: string | null;
}

/** What an {@link IndexProvider} returns — the indexing receipt or the reason it could not submit. */
export interface IndexPingResult {
  status: ProviderStatus;
  /** The search engine's submission receipt id — the external proof of submission. Null when failed. */
  receiptId: string | null;
  /** Human-readable failure reason; absent on success. */
  error?: string;
}

/**
 * A persisted pipeline run and everything it has accumulated — the audit row the approval/review flow reads.
 * Artifacts are filled in as their stage's gate passes; `null` means "not produced yet".
 */
export interface PipelineRun {
  id: string;
  workspaceId: string;
  /** The human's seed intent for the piece (DATA — drives keyword relevance, never gated as an instruction). */
  topic: string;
  /** The stage the run is waiting at (the next gate to clear), or `"done"` when completed. */
  stage: RunStage;
  status: RunStatus;
  /** Validated keyword (set once the `keyword` gate passes). */
  keyword: KeywordSpec | null;
  /** Approved brief (set once the `brief` gate passes). */
  brief: ContentBrief | null;
  /** Brand+fact-checked draft (set once the `draft` gate passes). */
  draft: ContentDraft | null;
  /** The live URL (set once `publish` succeeds). */
  publishedUrl: string | null;
  /** The indexing receipt (set once `index_ping` succeeds). */
  indexReceiptId: string | null;
  /** The #13 approval that authorized the publish — proof publish ran post-approval. Null until published. */
  publishApprovalId: string | null;
  /** The #13 approval that authorized the index ping — proof it ran post-approval. Null until pinged. */
  indexApprovalId: string | null;
  /** Why the run is currently `blocked` (the failed gate's reasons). Empty when `active`/`completed`. */
  blockedReasons: GateReason[];
  createdAt: Date;
  updatedAt: Date;
}

/** The machine-readable reason a stage gate blocked (or `ok` when it passed). */
export type GateCode =
  | "ok"
  | "keyword_empty"
  | "keyword_too_long"
  | "keyword_irrelevant"
  | "volume_too_low"
  | "difficulty_too_high"
  | "intent_not_allowed"
  | "brief_title_missing"
  | "brief_keyword_mismatch"
  | "brief_audience_missing"
  | "brief_outline_too_thin"
  | "brief_word_target_too_low"
  | "draft_title_missing"
  | "draft_too_short"
  | "draft_keyword_missing"
  | "draft_banned_phrase"
  | "draft_unsourced_claim"
  | "draft_no_claims"
  // The two side-effecting stages report their provider outcome through the same blocked-reason channel, so a
  // failed publish / index-ping leaves the run blocked-and-resumable rather than throwing.
  | "publish_failed"
  | "index_ping_failed";

/** One violated (or satisfied) gate rule. */
export interface GateReason {
  code: GateCode;
  message: string;
}

/** A pure, fail-closed gate verdict: `allow` only when `reasons` is empty. */
export interface GateDecision {
  decision: "allow" | "block";
  /** All violated rules. Empty iff allowed. Fail-closed: any entry ⇒ `block`. */
  reasons: GateReason[];
}

/** Terminal run stage. A run here is never advanced again by the normal flow. */
export function isTerminalStage(stage: RunStage): stage is "done" {
  return stage === "done";
}
