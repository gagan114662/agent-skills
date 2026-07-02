import type { BrandVoiceArtifact, BrandVoiceProfile } from "@reload/shared";

const MAX_EXCERPT_CHARS = 600;
const MAX_VOICE_CHARS = 2_000;
const MAX_SOURCE_URLS = 8;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu;
const SENTENCE_RE = /[^.!?\n]+[.!?]?/gu;
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "our",
  "are",
  "but",
  "not",
  "can",
  "will",
  "into",
  "about",
  "they",
  "their",
  "have",
  "has",
  "was",
  "were",
  "been",
  "than",
]);

export interface BrandVoiceEditInput {
  currentVoice?: string | null;
  originalDraft: string;
  editedDraft: string;
  sourceUrls?: string[];
  learnedAt?: string;
}

export interface BrandVoiceEditSuggestion {
  summary: string;
  changed: boolean;
  confirmationRequired: true;
  nextVoice: string;
  artifact: BrandVoiceArtifact;
}

function cleanText(value: string, max = MAX_EXCERPT_CHARS): string {
  const withoutControls = [...value]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("");
  return withoutControls.replace(/\s+/g, " ").trim().slice(0, max);
}

function unique(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value, 90);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

function words(text: string): string[] {
  return [...text.matchAll(WORD_RE)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function termDiff(preferred: string, avoided: string, fallback: string[]): string[] {
  const avoidedTerms = new Set(words(avoided));
  const terms = words(preferred).filter((word) => !avoidedTerms.has(word));
  return unique(terms, 8).length > 0 ? unique(terms, 8) : fallback;
}

function sentenceExamples(text: string): string[] {
  const sentences = [...text.matchAll(SENTENCE_RE)].map((match) => cleanText(match[0], 180));
  return unique(sentences, 3);
}

function averageWordsPerSentence(text: string): number {
  const sentences = sentenceExamples(text);
  if (sentences.length === 0) return 0;
  const total = sentences.reduce((sum, sentence) => sum + words(sentence).length, 0);
  return Math.round((total / sentences.length) * 10) / 10;
}

function inferSentenceRhythm(edited: string): string {
  const avg = averageWordsPerSentence(edited);
  if (avg > 0 && avg <= 8) return "Short, punchy sentences with quick handoffs.";
  if (avg <= 16) return "Medium-length sentences; plain setup, concrete payoff.";
  return "Longer explanatory cadence, but every sentence needs a concrete proof point.";
}

function inferToneAxes(original: string, edited: string, currentVoice: string): string[] {
  const axes: string[] = [];
  if (currentVoice.trim()) axes.push("preserve the owner's existing voice notes");
  if (edited.length < original.length * 0.85) axes.push("concise over padded");
  if (/\b(proof|receipt|source|specific|because|shows)\b/i.test(edited)) axes.push("proof-led over vague");
  if (/[!?]/.test(original) && !/[!?]/.test(edited)) axes.push("calm confidence over hype");
  axes.push("specific customer language over generic AI copy");
  return unique(axes, 5);
}

function normalizeSourceUrls(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return unique(values.filter((value) => /^https?:\/\//i.test(value)), MAX_SOURCE_URLS);
}

export function renderBrandVoiceProfile(profile: BrandVoiceProfile, currentVoice?: string | null): string {
  const lines = [
    currentVoice?.trim() ? "Existing voice notes: " + cleanText(currentVoice, 360) : "",
    "Tone axes: " + profile.toneAxes.join("; "),
    "Prefer: " + profile.vocabularyDo.join(", "),
    "Avoid: " + profile.vocabularyDont.join(", "),
    "Sentence rhythm: " + profile.sentenceRhythm,
    "Example lines: " + profile.exampleLines.join(" / "),
  ].filter(Boolean);
  return cleanText(lines.join("\n"), MAX_VOICE_CHARS);
}

export function distillBrandVoiceEdit(input: BrandVoiceEditInput): BrandVoiceEditSuggestion {
  const originalDraft = cleanText(input.originalDraft);
  const editedDraft = cleanText(input.editedDraft);
  const currentVoice = cleanText(input.currentVoice ?? "", 360);
  const changed = originalDraft !== editedDraft;
  const profile: BrandVoiceProfile = {
    toneAxes: inferToneAxes(originalDraft, editedDraft, currentVoice),
    vocabularyDo: termDiff(editedDraft, originalDraft, ["specific proof", "plain customer language"]),
    vocabularyDont: termDiff(originalDraft, editedDraft, ["generic claims", "hype without evidence"]),
    sentenceRhythm: inferSentenceRhythm(editedDraft),
    exampleLines: sentenceExamples(editedDraft).length > 0 ? sentenceExamples(editedDraft) : [editedDraft],
  };
  const artifact: BrandVoiceArtifact = {
    kind: "brand_voice",
    schemaVersion: 1,
    profile,
    sourceUrls: normalizeSourceUrls(input.sourceUrls),
    updatedFromOwnerEdit: {
      originalExcerpt: originalDraft,
      editedExcerpt: editedDraft,
      learnedAt: input.learnedAt ?? new Date().toISOString(),
    },
  };
  return {
    summary: changed
      ? "Owner edit distilled into a workspace voice profile update."
      : "No tone change detected; confirmation would keep the current voice profile.",
    changed,
    confirmationRequired: true,
    nextVoice: renderBrandVoiceProfile(profile, currentVoice),
    artifact,
  };
}
