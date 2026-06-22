/**
 * The per-stage gates for the SEO content pipeline (issue #598). These are the legible heart of the
 * "a post can only publish after passing every gate" guarantee: pure, FAIL-CLOSED functions that decide whether a
 * stage's artifact is good enough to move forward. Same inputs in, same {@link GateDecision} out — no clock, no
 * randomness, no IO.
 *
 * Fail-closed means each gate collects EVERY violated rule and blocks if there is even one. Adding a rule can only
 * ever make a gate stricter. #200 §6 trust boundary: every gate reads ONLY structural signals — numeric keyword
 * metrics, the presence/counts of brief sections, the draft's own word count and claim/source list — never by
 * interpreting the untrusted topic/brief/draft PROSE as an instruction. A poisoned topic cannot talk its way past.
 */

import type { GatePolicy } from "./caps.js";
import type {
  ContentBrief,
  ContentDraft,
  GateDecision,
  GateReason,
  KeywordMetrics,
} from "./types.js";

/** A trimmed, lowercased, deduped token list (alphanumeric words ≥ 2 chars). Used for relevance overlap. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2) out.add(raw);
  }
  return out;
}

/**
 * Relevance of a keyword to the run's topic, 0..1: the fraction of the KEYWORD's tokens that also appear in the
 * topic. The keyword defines the denominator, so a long topic never dilutes the score and a keyword whose every
 * word is on-topic scores 1.0. An empty keyword scores 0 (nothing to be relevant to). Pure and structural.
 */
export function computeKeywordRelevance(keyword: string, topic: string): number {
  const kw = tokenize(keyword);
  if (kw.size === 0) return 0;
  const tp = tokenize(topic);
  let overlap = 0;
  for (const t of kw) if (tp.has(t)) overlap += 1;
  return overlap / kw.size;
}

/** Build the final decision from collected reasons (fail-closed: any reason ⇒ block). */
function decide(reasons: GateReason[]): GateDecision {
  return { decision: reasons.length === 0 ? "allow" : "block", reasons };
}

/**
 * The keyword gate: a candidate keyword is worth pursuing only when it is non-empty, on-topic, has enough search
 * volume, is not too hard to rank for, and targets an allowed buyer intent. All checks are numeric/enum.
 */
export function evaluateKeywordGate(
  metrics: KeywordMetrics,
  relevance: number,
  policy: GatePolicy,
): GateDecision {
  const reasons: GateReason[] = [];
  const kw = metrics.keyword.trim();

  if (kw.length === 0) {
    reasons.push({ code: "keyword_empty", message: "keyword is empty" });
  }
  if (kw.length > 200) {
    reasons.push({ code: "keyword_too_long", message: `keyword is ${kw.length} chars (max 200)` });
  }
  if (relevance < policy.minKeywordRelevance) {
    reasons.push({
      code: "keyword_irrelevant",
      message: `relevance ${relevance.toFixed(2)} is below the ${policy.minKeywordRelevance.toFixed(2)} floor`,
    });
  }
  if (metrics.monthlyVolume < policy.minMonthlyVolume) {
    reasons.push({
      code: "volume_too_low",
      message: `monthly volume ${metrics.monthlyVolume} is below the ${policy.minMonthlyVolume} floor`,
    });
  }
  if (metrics.difficulty > policy.maxDifficulty) {
    reasons.push({
      code: "difficulty_too_high",
      message: `difficulty ${metrics.difficulty} exceeds the ${policy.maxDifficulty} ceiling`,
    });
  }
  if (!policy.allowedIntents.includes(metrics.intent)) {
    reasons.push({
      code: "intent_not_allowed",
      message: `intent "${metrics.intent}" is not in the allowed set`,
    });
  }
  return decide(reasons);
}

/**
 * The brief gate: a brief is "complete" only when it has a title, names the validated keyword as its primary
 * keyword, identifies an audience, has enough outline sections, and sets a sane word target. Structural counts
 * only — section/title prose is never interpreted.
 */
export function evaluateBriefGate(
  brief: ContentBrief,
  keyword: string,
  policy: GatePolicy,
): GateDecision {
  const reasons: GateReason[] = [];

  if (brief.title.trim().length === 0) {
    reasons.push({ code: "brief_title_missing", message: "brief has no title" });
  }
  if (brief.primaryKeyword.trim().toLowerCase() !== keyword.trim().toLowerCase()) {
    reasons.push({
      code: "brief_keyword_mismatch",
      message: `brief primary keyword "${brief.primaryKeyword}" does not match the validated keyword "${keyword}"`,
    });
  }
  if (brief.audience.trim().length === 0) {
    reasons.push({ code: "brief_audience_missing", message: "brief does not identify an audience" });
  }
  const sections = brief.outline.filter(
    (s) => s.heading.trim().length > 0 && s.summary.trim().length > 0,
  ).length;
  if (sections < policy.minBriefSections) {
    reasons.push({
      code: "brief_outline_too_thin",
      message: `brief has ${sections} complete outline section(s) (min ${policy.minBriefSections})`,
    });
  }
  if (brief.wordTarget < policy.minBriefWordTarget) {
    reasons.push({
      code: "brief_word_target_too_low",
      message: `brief word target ${brief.wordTarget} is below the ${policy.minBriefWordTarget} floor`,
    });
  }
  return decide(reasons);
}

/** Count whitespace-delimited words in a body. Pure; the brand gate's substance measure. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * The draft gate — the brand + fact check, the gate the issue calls out as the one that "catches junk drafts". A
 * draft passes only when it is on-brand (has a title, enough substance, mentions the keyword, and contains no
 * banned filler phrase) AND every factual claim it makes is backed by a source.
 *
 * The fact check reads ONLY the structural `claims[].sourceUrl` presence — it does not parse the body prose for
 * "facts", so the untrusted draft text can never trick the gate into passing an unsourced claim (#200 §6).
 */
export function evaluateDraftGate(
  draft: ContentDraft,
  brief: ContentBrief,
  policy: GatePolicy,
): GateDecision {
  const reasons: GateReason[] = [];

  // --- Brand checks ---
  if (draft.title.trim().length === 0) {
    reasons.push({ code: "draft_title_missing", message: "draft has no title" });
  }
  const words = wordCount(draft.body);
  const ratioFloor = Math.ceil(brief.wordTarget * policy.minDraftWordRatio);
  const floor = Math.max(policy.minDraftWords, ratioFloor);
  if (words < floor) {
    reasons.push({
      code: "draft_too_short",
      message: `draft body has ${words} words (min ${floor} = max of ${policy.minDraftWords} and ${(policy.minDraftWordRatio * 100).toFixed(0)}% of the ${brief.wordTarget}-word target)`,
    });
  }
  const haystack = `${draft.title}\n${draft.body}`.toLowerCase();
  if (brief.primaryKeyword.trim().length > 0 && !haystack.includes(brief.primaryKeyword.trim().toLowerCase())) {
    reasons.push({
      code: "draft_keyword_missing",
      message: `draft never mentions the primary keyword "${brief.primaryKeyword}"`,
    });
  }
  for (const phrase of policy.bannedPhrases) {
    const needle = phrase.trim().toLowerCase();
    if (needle.length > 0 && haystack.includes(needle)) {
      reasons.push({
        code: "draft_banned_phrase",
        message: `draft contains the banned phrase "${phrase}"`,
      });
      break; // one banned-phrase reason is enough; no need to enumerate them all.
    }
  }

  // --- Fact check: every claim must be sourced. ---
  if (draft.claims.length === 0) {
    reasons.push({
      code: "draft_no_claims",
      message: "draft makes no sourced claims (a publishable piece must cite at least one source)",
    });
  } else {
    const unsourced = draft.claims.filter((c) => c.sourceUrl.trim().length === 0).length;
    if (unsourced > 0) {
      reasons.push({
        code: "draft_unsourced_claim",
        message: `${unsourced} of ${draft.claims.length} claim(s) have no source`,
      });
    }
  }
  return decide(reasons);
}

/** Convenience: did a gate allow the artifact? */
export function isAllowed(decision: GateDecision): boolean {
  return decision.decision === "allow";
}
