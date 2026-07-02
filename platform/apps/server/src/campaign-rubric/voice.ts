/**
 * Voice & truth checks (#dogfood-harness). Pure. Two machine-checkable failure modes the mission calls out by
 * name — "was generic" and "broke voice / invented a metric":
 *
 *  1. AI-SLOP: a lexicon of the tells that make copy read like a language model wrote it. A hit doesn't fail
 *     an asset outright but caps craft and produces a concrete rewrite note naming the phrase.
 *  2. UNAPPROVED CLAIMS (#200 FM#2): a superlative or numeric claim ("10x faster", "the #1 platform",
 *     "50% cheaper") that is NOT covered by the brief's approved brand-claim allowlist. This is how an agent
 *     inventing a metric gets caught deterministically — the brief is the single source of truth for what we
 *     may claim, and anything outside it is flagged for a human.
 */
import type { CampaignAsset, ClaimViolation, SlopHit } from "./types.js";
import { assetCorpus } from "./spec.js";

/** The AI-slop / marketing-cliché lexicon. Whole-phrase, case-insensitive. Kept surgical to avoid noise. */
export const SLOP_PHRASES: readonly string[] = [
  "in today's fast-paced world",
  "in today's digital age",
  "in the ever-evolving",
  "game-changer",
  "game changer",
  "unlock the power",
  "unlock your",
  "elevate your",
  "take it to the next level",
  "seamlessly",
  "seamless integration",
  "revolutionize",
  "revolutionary",
  "cutting-edge",
  "state-of-the-art",
  "best-in-class",
  "world-class",
  "dive in",
  "let's dive",
  "in conclusion",
  "at the end of the day",
  "when it comes to",
  "look no further",
  "the future of",
  "supercharge",
  "turbocharge",
  "harness the power",
  "tapestry",
  "in the realm of",
  "navigate the",
  "empower",
  "leverage synergies",
  "move the needle",
  "boasts",
  "a myriad of",
  "plethora",
  "delve into",
];

/**
 * Superlative / absolute tells that require an approved claim to back them. Matched on token boundaries (see
 * {@link containsToken}), never raw substring — a raw `includes("any")` would false-flag "company",
 * "anything", "many", which a real dogfood run immediately exposed.
 */
const SUPERLATIVES: readonly string[] = [
  "the best",
  "#1",
  "number one",
  "fastest",
  "cheapest",
  "the most",
  "guaranteed",
  "unlimited",
  "instantly",
  "always",
  "never fails",
  "100%",
];

/** Numeric-claim shapes: percentages, multipliers, dollar amounts, "N hours/days/x". */
const NUMERIC_CLAIM_RE = /\b(\d+(?:\.\d+)?)\s*(%|x|×|hours?|days?|weeks?|minutes?|customers?|users?|dollars?)\b|\$\s?\d/gi;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Detect AI-slop phrases across every text fragment of an asset. */
export function detectSlop(asset: CampaignAsset): SlopHit[] {
  const hits: SlopHit[] = [];
  const seen = new Set<string>();
  const scan = (text: string, where: string) => {
    const lower = normalize(text);
    for (const phrase of SLOP_PHRASES) {
      if (lower.includes(phrase) && !seen.has(phrase)) {
        seen.add(phrase);
        hits.push({ phrase, where });
      }
    }
  };
  scan(assetCorpus(asset), asset.title || asset.kind);
  return hits;
}

/**
 * Detect superlative/numeric claims not backed by an approved brand claim. A claim is considered approved
 * when the fragment carrying it shares a normalized token (the number, or the superlative word) with any
 * allowlisted claim — so "10x more agents" is fine iff the allowlist actually contains a "10x" claim.
 */
export function detectUnapprovedClaims(asset: CampaignAsset, approvedClaims: readonly string[]): ClaimViolation[] {
  const approved = approvedClaims.map(normalize);
  const backed = (fragment: string): boolean => {
    const f = normalize(fragment);
    return approved.some((claim) => claim.includes(f) || f.includes(claim) || sharesToken(claim, f));
  };
  const out: ClaimViolation[] = [];
  const seen = new Set<string>();
  const push = (claim: string, where: string) => {
    const key = normalize(claim);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push({ claim, where });
    }
  };

  const corpus = assetCorpus(asset);
  // Numeric claims: take a small window around each numeric hit and require an approved backer.
  for (const m of corpus.matchAll(NUMERIC_CLAIM_RE)) {
    const idx = m.index ?? 0;
    const fragment = corpus.slice(Math.max(0, idx - 20), idx + m[0].length + 20).replace(/\s+/g, " ").trim();
    if (!backed(m[0])) push(fragment, asset.title || asset.kind);
  }
  // Superlatives: flag when the exact superlative (token-bounded) isn't present in any approved claim.
  const lower = normalize(corpus);
  for (const s of SUPERLATIVES) {
    if (containsToken(lower, s) && !approved.some((c) => containsToken(c, s))) {
      push(s, asset.title || asset.kind);
    }
  }
  return out;
}

/**
 * True when `token` appears in `text` bounded by non-alphanumeric edges (or string ends) — so "any" does not
 * match inside "company"/"anything", while "#1" and "100%" still match despite their non-word characters.
 */
function containsToken(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(text);
}

/** True when two normalized fragments share a meaningful (non-stopword, len>3 or numeric) token. */
function sharesToken(a: string, b: string): boolean {
  const toks = (s: string) => new Set(s.split(/[^a-z0-9%$×.]+/i).filter((t) => t.length > 3 || /\d/.test(t)));
  const A = toks(a);
  for (const t of toks(b)) if (A.has(t)) return true;
  return false;
}
