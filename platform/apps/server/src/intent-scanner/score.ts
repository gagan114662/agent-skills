import type {
  IntentCandidate,
  IntentEvidence,
  IntentMonitorDefinition,
  IntentScore,
} from "./types.js";

const MAX_EVIDENCE = 3;
const MAX_QUOTE = 220;

const PURCHASE_PATTERNS = [
  "alternative to",
  "alternatives to",
  "recommend",
  "recommendation",
  "looking for",
  "need a tool",
  "best tool",
  "which tool",
  "what should i use",
  "anyone using",
  "compare",
  "pricing",
  "budget",
];

const PAIN_PATTERNS = [
  "struggling with",
  "frustrated",
  "too expensive",
  "takes too long",
  "manual",
  "can't keep up",
  "cannot keep up",
  "wasting time",
  "hard to",
  "need help",
  "doesn't work",
  "not working",
];

const CHURN_PATTERNS = [
  "switching from",
  "migrate from",
  "leaving",
  "canceling",
  "cancelling",
  "replace",
  "replacing",
  "moving off",
  "ditching",
];

const NOISE_PATTERNS = ["meme", "joke", "hiring", "job opening", "giveaway", "coupon", "press release"];

export function scoreIntentCandidate(
  monitor: IntentMonitorDefinition,
  candidate: IntentCandidate,
): IntentScore {
  const title = normalize(candidate.title);
  const body = normalize(candidate.body ?? "");
  const haystack = [title, body].filter(Boolean).join("\n\n");
  const evidence: IntentEvidence[] = [];
  const matchedSignals = new Set<string>();

  let score = 0;
  let activePurchase = 0;
  let pain = 0;
  let churn = 0;
  let noise = 0;

  for (const keyword of [...monitor.keywords, ...monitor.questionPatterns]) {
    if (matchesKeyword(haystack, keyword)) {
      score += 45;
      activePurchase += 1;
      matchedSignals.add(keyword);
      addEvidence(evidence, haystack, keyword, "matches a configured buying-intent query");
    }
  }

  for (const competitor of monitor.competitors) {
    if (matchesKeyword(haystack, competitor)) {
      score += 10;
      churn += 1;
      matchedSignals.add(competitor);
      addEvidence(evidence, haystack, competitor, "mentions a configured competitor");
    }
  }

  for (const pattern of PURCHASE_PATTERNS) {
    if (matchesKeyword(haystack, pattern)) {
      score += 14;
      activePurchase += 1;
      matchedSignals.add(pattern);
      addEvidence(evidence, haystack, pattern, "shows active vendor/tool research");
    }
  }

  for (const pattern of PAIN_PATTERNS) {
    if (matchesKeyword(haystack, pattern)) {
      score += 12;
      pain += 1;
      matchedSignals.add(pattern);
      addEvidence(evidence, haystack, pattern, "states a current operational pain");
    }
  }

  for (const pattern of CHURN_PATTERNS) {
    if (matchesKeyword(haystack, pattern)) {
      score += 18;
      churn += 1;
      matchedSignals.add(pattern);
      addEvidence(evidence, haystack, pattern, "signals replacement or competitor churn");
    }
  }

  for (const pattern of NOISE_PATTERNS) {
    if (matchesKeyword(haystack, pattern)) {
      noise += 1;
      score -= 20;
      matchedSignals.add(pattern);
    }
  }

  const category =
    noise > 0 && score < 35
      ? "noise"
      : churn > 0
        ? "competitor_churn"
        : activePurchase > 0
          ? "active_purchase_research"
          : pain > 0
            ? "pain_expression"
            : "noise";

  if (category === "noise") {
    score = Math.min(score, 35);
  }

  return {
    category,
    score: clamp(score, 0, 100),
    evidence: evidence.slice(0, MAX_EVIDENCE),
    matchedSignals: Array.from(matchedSignals).slice(0, 10),
  };
}

export function matchesKeyword(text: string, keyword: string): boolean {
  const cleaned = normalize(keyword);
  if (!cleaned) return false;
  return unicodeKeywordRegex(cleaned).test(text);
}

function unicodeKeywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp("(^|[^\\p{L}\\p{N}_])(" + escaped + ")(?=$|[^\\p{L}\\p{N}_])", "iu");
}

function addEvidence(evidence: IntentEvidence[], text: string, needle: string, reason: string): void {
  if (evidence.length >= MAX_EVIDENCE) return;
  const quote = quoteAround(text, needle);
  if (!quote || evidence.some((e) => e.quote === quote)) return;
  evidence.push({ quote, reason });
}

function quoteAround(text: string, needle: string): string {
  const normalized = normalize(text);
  const index = normalized.toLocaleLowerCase().indexOf(normalize(needle).toLocaleLowerCase());
  if (index < 0) return normalized.slice(0, MAX_QUOTE).trim();
  const start = Math.max(0, index - 70);
  const end = Math.min(normalized.length, index + needle.length + 110);
  return normalized.slice(start, end).replace(/^\S*\s+/, "").replace(/\s+\S*$/, "").trim().slice(0, MAX_QUOTE);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
