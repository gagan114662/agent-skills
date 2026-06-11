/**
 * Customer Voice Loop classifier (#114, ADR-0114) — the **pure**, deterministic core. Turns one inbound
 * feedback signal (a support message, a checkout abandon, a cancellation reason, or an NPS response) into
 * a structured `{ sentiment, churnRisk, category }` classification. No IO, no clock, no model call — so
 * the classification that becomes a `user_voice` evidence row is unit-tested in isolation (the #96
 * `rubric.ts` pattern). The LLM-drafted *reply* is a separate, #13-gated path; classification is rules.
 */

export type Sentiment = "positive" | "neutral" | "negative";
export type ChurnRisk = "low" | "medium" | "high";
export type VoiceCategory =
  | "bug"
  | "pricing"
  | "feature_request"
  | "praise"
  | "churn"
  | "support"
  | "other";
/** Where a voice signal came from — the discriminator on the evidence row. */
export type VoiceSourceKind = "support_ticket" | "checkout_abandon" | "cancellation" | "nps";

export interface FeedbackInput {
  sourceKind: VoiceSourceKind;
  /** The free-text body (a ticket body, a cancellation reason, an NPS comment). May be empty. */
  text: string;
  /** The 0–10 NPS score when `sourceKind === "nps"`. When present it dominates the sentiment/churn bands. */
  npsScore?: number | null;
}

export interface VoiceClassification {
  sentiment: Sentiment;
  churnRisk: ChurnRisk;
  category: VoiceCategory;
  /** The matched rules/keywords, for transparency in the evidence row (and easy auditing). */
  signals: string[];
}

const NEGATIVE_WORDS = [
  "broken", "bug", "crash", "error", "slow", "terrible", "awful", "hate", "angry",
  "frustrated", "disappointed", "useless", "worst", "doesn't work", "not working",
  "fails", "failing", "annoying", "confusing", "stuck",
];
const POSITIVE_WORDS = [
  "love", "great", "awesome", "amazing", "excellent", "fantastic", "perfect",
  "helpful", "happy", "thank", "thanks", "wonderful", "brilliant",
];
const CHURN_WORDS = [
  "cancel", "cancelling", "canceling", "unsubscribe", "refund", "switching", "switch",
  "competitor", "too expensive", "leaving", "leave", "churn", "downgrade", "disappointed",
];

/** Category keyword sets, evaluated in priority order. */
const CATEGORY_RULES: { category: VoiceCategory; words: string[] }[] = [
  { category: "bug", words: ["bug", "crash", "error", "broken", "not working", "doesn't work", "fails", "glitch", "stuck"] },
  { category: "feature_request", words: ["feature", "would love if", "wish", "please add", "suggestion", "request", "missing", "could you add"] },
  { category: "pricing", words: ["price", "pricing", "expensive", "cost", "refund", "billing", "charge", "subscription", "invoice"] },
  { category: "churn", words: ["cancel", "unsubscribe", "leaving", "switch", "competitor", "downgrade"] },
  { category: "praise", words: ["love", "great", "awesome", "amazing", "thank", "excellent", "fantastic", "perfect", "wonderful"] },
];

function matches(text: string, words: string[]): string[] {
  return words.filter((w) => text.includes(w));
}

/**
 * Classify one feedback signal. Total + deterministic. Precedence:
 *   1. An NPS score (when present) is authoritative for sentiment + churn band (0–6 detractor,
 *      7–8 passive, 9–10 promoter) — a number a stranger gave beats keyword guessing.
 *   2. A `cancellation` is negative + high churn by construction (they are leaving).
 *   3. Otherwise sentiment is the keyword balance, churn rises on churn keywords, and a
 *      `checkout_abandon` floors churn at medium (a soft, not-yet-lost signal).
 * Category is keyword-routed (bug > feature_request > pricing > churn > praise), with sensible
 * source-kind fallbacks.
 */
export function classifyFeedback(input: FeedbackInput): VoiceClassification {
  const text = (input.text ?? "").toLowerCase();
  const signals: string[] = [];

  const negHits = matches(text, NEGATIVE_WORDS);
  const posHits = matches(text, POSITIVE_WORDS);
  const churnHits = matches(text, CHURN_WORDS);

  // --- sentiment + churn risk ---
  let sentiment: Sentiment;
  let churnRisk: ChurnRisk;

  const nps = input.sourceKind === "nps" && typeof input.npsScore === "number" ? input.npsScore : null;
  if (nps !== null) {
    if (nps <= 6) {
      sentiment = "negative";
      churnRisk = "high";
      signals.push("nps_detractor");
    } else if (nps <= 8) {
      sentiment = "neutral";
      churnRisk = "medium";
      signals.push("nps_passive");
    } else {
      sentiment = "positive";
      churnRisk = "low";
      signals.push("nps_promoter");
    }
  } else if (input.sourceKind === "cancellation") {
    sentiment = "negative";
    churnRisk = "high";
    signals.push("cancellation");
  } else {
    sentiment = negHits.length > posHits.length ? "negative" : posHits.length > negHits.length ? "positive" : "neutral";
    if (churnHits.length > 0) {
      churnRisk = "high";
    } else if (sentiment === "negative") {
      churnRisk = "medium";
    } else {
      churnRisk = "low";
    }
    if (input.sourceKind === "checkout_abandon" && churnRisk === "low") {
      // An abandoned checkout is a soft churn signal even with neutral wording.
      churnRisk = "medium";
      signals.push("checkout_abandon");
    }
  }
  if (negHits.length) signals.push(...negHits.map((w) => `neg:${w}`));
  if (posHits.length) signals.push(...posHits.map((w) => `pos:${w}`));
  if (churnHits.length) signals.push(...churnHits.map((w) => `churn:${w}`));

  // --- category ---
  let category: VoiceCategory = "other";
  for (const rule of CATEGORY_RULES) {
    if (matches(text, rule.words).length > 0) {
      category = rule.category;
      break;
    }
  }
  if (category === "other") {
    // Source-kind + sentiment fallbacks when no keyword routed it.
    if (input.sourceKind === "cancellation") category = "churn";
    else if (nps !== null && sentiment === "positive") category = "praise";
    else if (input.sourceKind === "support_ticket") category = "support";
    else category = "other";
  }
  // A positive NPS promoter is praise even if a keyword pointed elsewhere weakly.
  if (nps !== null && sentiment === "positive" && category === "support") category = "praise";

  return { sentiment, churnRisk, category, signals };
}
