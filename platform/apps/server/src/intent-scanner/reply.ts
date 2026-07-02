import type { IntentCandidate, IntentScore } from "./types.js";

const MAX_REPLY = 600;

export function draftIntentReply(input: {
  productName?: string | null;
  candidate: IntentCandidate;
  score: IntentScore;
}): string {
  const product = clean(input.productName) || "ipop";
  const evidence = input.score.evidence[0]?.quote ?? input.candidate.title;
  const opener =
    input.score.category === "competitor_churn"
      ? "Saw your note about switching tools."
      : input.score.category === "pain_expression"
        ? "Saw the pain you described here."
        : "Saw your question while you are comparing options.";
  const reply = [
    opener,
    "",
    "A practical way to think about this: if the goal is turning scattered marketing work into shipped campaigns, " +
      product +
      " can give you a small agent team that researches, drafts, stages, and leaves approval receipts before anything goes out.",
    "",
    "The bit that stood out: \"" + trimQuote(evidence) + "\"",
    "",
    "If useful, I can share a concrete before/after workflow for your use case rather than a generic feature list.",
  ].join("\n");
  return reply.slice(0, MAX_REPLY);
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function trimQuote(value: string): string {
  return clean(value).replace(/"/g, "'").slice(0, 180);
}
