/**
 * Factual-claim + source checker (issue #627) — the "is this true, and can we prove it?" half of the
 * pre-publish gate.
 *
 * THE PROBLEM (#627): agents invent statistics, superlatives and "studies show…" claims, and the runaway
 * session published them unsourced. THE FIX (this file): a pure, deterministic extractor that finds the
 * CHECKABLE factual claims in a draft (hard numbers/stats, ranking superlatives, appeals to research) and
 * flags every one that ships WITHOUT a citation. A claim is satisfied if the draft provides a source near it
 * — an inline URL, a footnote marker, an attribution ("according to …", "per …", "(source: …)") — or if the
 * claim was pre-approved by the brand (the brief's allowlist, passed in as {@link FactCheckOptions.approvedClaims}).
 *
 * The checker does NOT itself verify the claim is true — it cannot reach the web and stays pure/offline. It
 * enforces the weaker but decisive property the acceptance criterion needs: nothing factual goes public
 * without a source on the page. An unsourced claim is the failure; the human (or a downstream researcher)
 * supplies the source on revision. This mirrors the content-guard split (#674): detection is heuristic and
 * over-reports; the gate is what blocks.
 *
 * Pure + total: a string (+ options) in, a structured result out. No IO, no clock, no model call. Sentence
 * splitting is intentionally simple (terminal punctuation) so the same draft always yields the same claims.
 *
 * #200 (FM#6): claim text and approved-claim text are DATA compared literally; nothing is executed.
 */

/** The families of checkable claim we recognize. */
export const CLAIM_KINDS = ["statistic", "research-appeal", "superlative"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** How load-bearing an unsourced claim is. Hard numbers / cited research must have a source; rankings are softer. */
export type ClaimSeverity = "medium" | "high";

/** One checkable factual claim found in the draft. */
export interface FactClaim {
  kind: ClaimKind;
  severity: ClaimSeverity;
  /** The sentence (collapsed + truncated) that carries the claim. */
  sentence: string;
  /** What specifically tripped the detector (e.g. the matched statistic / superlative). */
  trigger: string;
  /** True when the claim's sentence carries a usable source, or the claim is on the brand allowlist. */
  sourced: boolean;
}

/** The result of fact-checking a draft. */
export interface FactResult {
  /** Every checkable claim found, in document order. */
  claims: FactClaim[];
  /** The subset of {@link claims} that ship without a source — the publishing blockers. */
  unsourced: FactClaim[];
  /** The worst severity across the UNSOURCED claims (`null` when every claim is sourced). */
  worstUnsourcedSeverity: ClaimSeverity | null;
}

/** Options for {@link checkFactualClaims}. */
export interface FactCheckOptions {
  /**
   * Claims the brand has pre-approved (typically the campaign brief's `brandClaims`, #588). A draft claim
   * whose sentence contains an approved claim as a substring is treated as sourced — the owner already
   * vouched for it, so it needs no external citation.
   */
  approvedClaims?: string[];
}

interface ClaimRule {
  kind: ClaimKind;
  severity: ClaimSeverity;
  pattern: RegExp;
}

/**
 * The claim signatures. Broad on purpose (over-report): a sentence matching any of these is treated as a
 * factual assertion that needs backing.
 */
const CLAIM_RULES: readonly ClaimRule[] = [
  // Hard statistics: percentages, money, multipliers, and "N customers/users/companies" style counts.
  {
    kind: "statistic",
    severity: "high",
    pattern:
      /\b\d[\d,.]*\s?%|\b\d+(\.\d+)?\s?x\b|[$£€]\s?\d|\b\d[\d,]{2,}\s+(customers|users|companies|businesses|downloads|installs|teams|developers)\b|\b\d+(\.\d+)?\s?(million|billion|thousand|k|m|bn)\b/i,
  },
  // Appeals to research / authority — the "studies show" family that demands a citation.
  {
    kind: "research-appeal",
    severity: "high",
    pattern:
      /\b(studies|research|surveys?|data|reports?|science|scientists?|experts?|analysts?)\s+(show|shows|prove|proves|proven|found|find|confirm|confirms|say|says|suggest|suggests|indicate|indicates)\b|\baccording\s+to\s+(a\s+)?(study|research|report|survey)\b|\b\d+\s+out\s+of\s+\d+\b/i,
  },
  // Ranking superlatives — comparative claims about market position.
  {
    kind: "superlative",
    severity: "medium",
    pattern:
      /\b(the\s+)?#\s?1\b|\bnumber\s+one\b|\bthe\s+(most|best|fastest|leading|largest|biggest|top|only)\b|\bindustry[\s-]?leading\b|\bmarket[\s-]?leader\b|\boutperforms?\b/i,
  },
];

/**
 * Markers that count as a source PRESENT within a claim's sentence: an inline URL, a footnote/endnote marker
 * (`[1]`, `(2)`), or an attribution phrase. If any is present in the sentence, the claim is considered sourced.
 */
const SOURCE_MARKERS: readonly RegExp[] = [
  /https?:\/\/\S+/i,
  /\[\d+\]|\(\d+\)/,
  /\b[Aa]ccording\s+to\s+["'(]*[A-Z0-9]/,
  /\b[Pp]er\s+["'(]*[A-Z][a-z]/,
  /\bsource\s*[:-]/i,
  /\bcit(?:e|ed|ation)\b/i,
  /\(\s*source[^)]*\)/i,
];

/** Collapse whitespace, trim, truncate. */
function clip(value: string, max = 200): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * Split a draft into sentences. Deliberately simple and deterministic: break on terminal punctuation
 * (`.`/`!`/`?`) followed by whitespace, and on newlines (so list items and headings are their own units).
 * Good enough to localize a claim and look for a source beside it.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when `sentence` carries any source marker. */
function hasSourceMarker(sentence: string): boolean {
  return SOURCE_MARKERS.some((re) => re.test(sentence));
}

/** True when `sentence` contains any approved-claim string (case-insensitive substring). */
function matchesApproved(sentence: string, approved: readonly string[]): boolean {
  const lower = sentence.toLowerCase();
  return approved.some((c) => {
    const t = c.trim().toLowerCase();
    return t.length > 0 && lower.includes(t);
  });
}

const SEVERITY_RANK: Record<ClaimSeverity, number> = { medium: 2, high: 3 };

/**
 * Extract the checkable factual claims from a draft and mark each sourced / unsourced. Pure + total. An empty
 * / non-string draft yields no claims. A sentence can match at most one claim kind (the first rule that fires,
 * most-load-bearing first) so the same draft always produces the same claim list.
 */
export function checkFactualClaims(content: string, options: FactCheckOptions = {}): FactResult {
  const claims: FactClaim[] = [];
  if (typeof content !== "string" || content.length === 0) {
    return { claims, unsourced: [], worstUnsourcedSeverity: null };
  }
  const approved = (options.approvedClaims ?? []).filter((c): c is string => typeof c === "string");

  for (const sentence of splitSentences(content)) {
    for (const rule of CLAIM_RULES) {
      const match = rule.pattern.exec(sentence);
      if (!match) continue;
      const sourced = hasSourceMarker(sentence) || matchesApproved(sentence, approved);
      claims.push({
        kind: rule.kind,
        severity: rule.severity,
        sentence: clip(sentence),
        trigger: clip(match[0], 80),
        sourced,
      });
      break; // one claim per sentence — first (most load-bearing) rule wins
    }
  }

  const unsourced = claims.filter((c) => !c.sourced);
  let worstUnsourcedSeverity: ClaimSeverity | null = null;
  for (const c of unsourced) {
    if (worstUnsourcedSeverity === null || SEVERITY_RANK[c.severity] > SEVERITY_RANK[worstUnsourcedSeverity]) {
      worstUnsourcedSeverity = c.severity;
    }
  }
  return { claims, unsourced, worstUnsourcedSeverity };
}
