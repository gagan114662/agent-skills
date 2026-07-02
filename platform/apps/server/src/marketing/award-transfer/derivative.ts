/**
 * Cross-industry award-transfer — Lens's derivative check (#1547, ADR-1547). Pure, no IO.
 *
 * The guardrail the issue names: transfer the APPROACH, never copy the execution. A territory brief hands a
 * drafter a mechanism from an unrelated industry ("own the flaw", "hijack a ritual"). The failure mode is a
 * drafter who lazily lifts the SOURCE's literal execution — its brand, its campaign name, or its specific
 * props ("empty bucket", "charging bull") — rather than reinventing the move for the client. This is Lens's
 * screen: given a draft and the source case behind its territory, flag any reuse of that case's literal
 * execution so Lens can send it back.
 *
 * It works off {@link AwardCase.executionMotifs} — the case-specific surface catalogued in `corpus.ts` — plus
 * the source brand and campaign name. It is deliberately conservative about false positives: it matches on
 * distinctive multi-word motifs / proper names, not on the abstract mechanism words (a draft is SUPPOSED to
 * embody the mechanism). Pure ⇒ unit-testable; it decides, it never edits or blocks (Lens owns the verdict).
 */

import { type AwardCase } from "./corpus.js";

/** The verdict for a draft screened against one source case. */
export interface DerivativeFinding {
  /** True when the draft reuses the source's literal execution (brand / campaign / a specific motif). */
  derivative: boolean;
  /** The offending copied elements found in the draft (empty when clean). */
  matched: string[];
  /** A human-readable explanation Lens can surface. */
  reason: string;
}

/** Normalize text for matching: lowercase, punctuation → space, whitespace collapsed. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `needle` (already a normalized phrase) appears as a whole run inside normalized `haystack`. */
function containsPhrase(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  if (!n) return false;
  // Word-boundary-safe: pad both sides with spaces so a short motif can't match inside a longer token.
  return ` ${haystack} `.includes(` ${n} `);
}

/**
 * Screen a draft against ONE source case. The draft is derivative when it reuses the source brand, the
 * source campaign name, or any of the case's execution motifs — i.e. it copied the execution instead of
 * transferring the mechanism. Citing the case in a BRIEF is fine; this screens the client-facing DRAFT.
 */
export function checkDerivative(draft: string, source: AwardCase): DerivativeFinding {
  const hay = normalize(draft);
  const candidates: string[] = [source.brand, source.campaign, ...source.executionMotifs];
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const cand of candidates) {
    const key = normalize(cand);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (containsPhrase(hay, cand)) matched.push(cand);
  }
  if (matched.length === 0) {
    return {
      derivative: false,
      matched: [],
      reason: `No execution overlap with "${source.campaign}" (${source.brand}) — the mechanism was transferred, not copied.`,
    };
  }
  return {
    derivative: true,
    matched,
    reason:
      `Draft reuses execution from "${source.campaign}" (${source.brand}): ${matched.join(", ")}. ` +
      "Transfer the mechanism, not the execution — reinvent the idea for this client.",
  };
}

/** The aggregate verdict for a draft screened against every source case behind its territories. */
export interface DerivativeScreen {
  /** True when the draft is derivative of ANY source case. */
  derivative: boolean;
  /** Every offending element across all cases (de-duplicated, order preserved). */
  matched: string[];
  /** Per-case findings (only the cases that flagged). */
  findings: Array<{ caseId: string; finding: DerivativeFinding }>;
}

/**
 * Screen a draft against every source case behind a set of territory briefs (Lens's real call). Returns the
 * aggregate verdict plus the per-case findings that flagged — so Lens can name exactly which reference the
 * drafter leaned on too hard.
 */
export function screenDraftAgainstCases(draft: string, cases: readonly AwardCase[]): DerivativeScreen {
  const findings: Array<{ caseId: string; finding: DerivativeFinding }> = [];
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    const finding = checkDerivative(draft, c);
    if (finding.derivative) {
      findings.push({ caseId: c.id, finding });
      for (const m of finding.matched) {
        if (!seen.has(m)) {
          seen.add(m);
          matched.push(m);
        }
      }
    }
  }
  return { derivative: findings.length > 0, matched, findings };
}
