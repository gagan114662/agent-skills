import { gatePublish, profileFromBrief } from "../brand-fact-gate/index.js";
import type { Deliverable, IndependentGrader } from "./engine.js";
import type { CheckObservation, DefinitionOfDone, SuccessCriterion } from "./types.js";

export const DEFAULT_VERIFIER_MEMBER_ID = "00000000-0000-0000-0000-000000000854";
export const ORIGINALITY_SIMILARITY_THRESHOLD = 0.82;

/** Build the deterministic default independent grader used when verification is enabled. */
export function createDefaultIndependentGrader(
  graderMemberId = DEFAULT_VERIFIER_MEMBER_ID,
): IndependentGrader {
  return {
    grade: async ({ deliverable, dod }) => ({
      graderMemberId,
      observations: gradeWithLocalChecks(deliverable, dod),
    }),
  };
}

/** Grade only the criteria this local verifier can actually check; unknown criteria fail closed. */
export function gradeWithLocalChecks(deliverable: Deliverable, dod: DefinitionOfDone): CheckObservation[] {
  return dod.criteria.map((criterion) => gradeCriterion(deliverable, criterion));
}

function gradeCriterion(deliverable: Deliverable, criterion: SuccessCriterion): CheckObservation {
  switch (criterion.id) {
    case "on_brief":
    case "answers_question":
    case "intended_change":
    case "builds_clean":
      return contentPresence(deliverable, criterion.id);
    case "brand_safe":
    case "tone_ok":
      return brandVoice(deliverable, criterion.id);
    case "no_pii_leak":
      return piiLeak(deliverable);
    case "originality":
      return originality(deliverable);
    default:
      return {
        criterionId: criterion.id,
        satisfied: false,
        confidence: 0,
        evidence: `no local grader for criterion ${criterion.id} — failing closed`,
        productionGrounded: false,
      };
  }
}

function contentPresence(deliverable: Deliverable, criterionId: string): CheckObservation {
  const words = tokenize(deliverable.content);
  const satisfied = words.length >= 8;
  return {
    criterionId,
    satisfied,
    confidence: satisfied ? 0.72 : 0.95,
    evidence: satisfied
      ? `content has ${words.length} words, enough for a substantive deliverable`
      : "content is too thin to verify against the brief",
    productionGrounded: false,
  };
}

function brandVoice(deliverable: Deliverable, criterionId: string): CheckObservation {
  const decision = gatePublish({
    content: deliverable.content,
    voiceProfile: profileFromBrief({
      voice: deliverable.brandVoice,
      constraints: deliverable.brandVoice ? [deliverable.brandVoice] : [],
      brandClaims: deliverable.brandClaims ?? [],
    }),
    approvedClaims: deliverable.brandClaims ?? [],
  });
  const voiceNotes = decision.voice.findings.map((f) => `${f.kind}: ${f.label}`);
  return {
    criterionId,
    satisfied: decision.allowed,
    confidence: decision.allowed ? 0.82 : 0.94,
    evidence: decision.allowed
      ? `brand/fact gate passed: ${decision.summary}`
      : `brand/fact gate failed: ${[...voiceNotes, ...decision.revisionNotes].join("; ")}`,
    productionGrounded: false,
  };
}

function piiLeak(deliverable: Deliverable): CheckObservation {
  const hits = secretSignals(deliverable.content);
  return {
    criterionId: "no_pii_leak",
    satisfied: hits.length === 0,
    confidence: hits.length === 0 ? 0.86 : 0.98,
    evidence: hits.length === 0 ? "no obvious secret or private-data pattern detected" : `possible private data: ${hits.join(", ")}`,
    productionGrounded: false,
  };
}

function originality(deliverable: Deliverable): CheckObservation {
  const sources = deliverable.originalitySources ?? [];
  const scored = sources
    .map((source) => ({ id: source.id, score: shingleSimilarity(deliverable.content, source.text) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const copied = best !== undefined && best.score >= ORIGINALITY_SIMILARITY_THRESHOLD;
  return {
    criterionId: "originality",
    satisfied: !copied,
    confidence: best ? 0.9 : 0.7,
    evidence: best
      ? copied
        ? `too similar to known source ${best.id}: similarity ${best.score.toFixed(2)}`
        : `highest known-source similarity ${best.score.toFixed(2)} from ${best.id}, below ${ORIGINALITY_SIMILARITY_THRESHOLD}`
      : "no known comparison source supplied; no high-similarity source match detected",
    productionGrounded: false,
  };
}

function secretSignals(text: string): string[] {
  const signals: string[] = [];
  if (/sk-[A-Za-z0-9_-]{16,}/.test(text)) signals.push("api-key-like token");
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) signals.push("ssn-like number");
  if (/\b(?:\d[ -]*?){13,19}\b/.test(text)) signals.push("card-like number");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) signals.push("private key");
  return signals;
}

function shingleSimilarity(a: string, b: string): number {
  const aShingles = shingles(tokenize(a));
  const bShingles = shingles(tokenize(b));
  if (aShingles.size === 0 || bShingles.size === 0) return 0;
  let intersection = 0;
  for (const shingle of aShingles) {
    if (bShingles.has(shingle)) intersection += 1;
  }
  const union = new Set([...aShingles, ...bShingles]).size;
  return union === 0 ? 0 : intersection / union;
}

function shingles(tokens: string[], width = 5): Set<string> {
  if (tokens.length === 0) return new Set();
  if (tokens.length < width) return new Set([tokens.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - width; i += 1) {
    out.add(tokens.slice(i, i + width).join(" "));
  }
  return out;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
