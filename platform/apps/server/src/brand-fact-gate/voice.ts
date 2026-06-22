/**
 * Brand-voice conformance checker (issue #627) — the "is this on-brand?" half of the pre-publish gate.
 *
 * THE PROBLEM (#627): a runaway session shipped off-brand / junk content because nothing checked tone before
 * it went public. THE FIX (this file): a pure, deterministic scorer that reads a draft against a
 * {@link BrandVoiceProfile} and returns an explainable voice score plus the specific off-brand signals it
 * carries. The gate (`gate.ts`) turns a low score / hard violation into a publish block.
 *
 * Design mirrors the lead-scoring model (#611): legible and explainable, not opaque. Content starts at a
 * perfect {@link MAX_VOICE_SCORE} and each off-brand finding deducts a documented number of points, so the
 * returned `findings` list is the literal audit trail of the number — a reviewer can see exactly why a draft
 * failed and what to fix.
 *
 * Pure + total: a string (+ profile) in, a structured result out. No IO, no clock, no model call — it runs in
 * the offline unit job and is deterministic. Like the content-guard detector (#674) it OVER-reports rather
 * than under-reports: a voice finding only ever ADDS caution (lowers the score), never declassifies, so a
 * false positive costs an author one revision while a false negative ships junk.
 *
 * #200 (FM#6): the brand profile is OWNER-authored DATA the gate compares against; nothing in the draft or
 * the profile is ever executed as an instruction. The profile's banned phrases are matched literally.
 */

/** Highest possible voice score; a clean draft scores this. The gate compares against a configurable floor. */
export const MAX_VOICE_SCORE = 100;

/** The families of off-brand signal the checker recognizes, ordered roughly most-damaging first. */
export const VOICE_FINDING_KINDS = [
  "banned-phrase",
  "clickbait",
  "false-guarantee",
  "hype",
  "shouting",
  "emoji-spam",
] as const;
export type VoiceFindingKind = (typeof VOICE_FINDING_KINDS)[number];

/** How serious one off-brand signal is. Drives both the point penalty and whether the gate can hard-fail on it. */
export type VoiceSeverity = "low" | "medium" | "high";

/** Points deducted from {@link MAX_VOICE_SCORE} per finding of each severity. */
export const VOICE_PENALTY: Record<VoiceSeverity, number> = { low: 6, medium: 14, high: 28 };

/** One detected off-brand signal: its family, severity, a human-readable reason, and the offending excerpt. */
export interface VoiceFinding {
  kind: VoiceFindingKind;
  severity: VoiceSeverity;
  /** Why this is off-brand — safe to show a human and to surface as a revision note. */
  label: string;
  /** The matched substring (collapsed + truncated) so an author can locate it. */
  excerpt: string;
}

/** The result of checking a draft against a brand-voice profile. */
export interface VoiceResult {
  /** {@link MAX_VOICE_SCORE} minus the summed penalties, floored at 0. Higher is more on-brand. */
  score: number;
  /** The worst severity across all findings (`null` when the draft is clean). */
  worstSeverity: VoiceSeverity | null;
  /** Every off-brand signal that fired, in detection order. The audit trail of the score. */
  findings: VoiceFinding[];
}

/**
 * The owner-authored brand-voice rules the checker compares a draft against. Built-in lexicons (hype,
 * clickbait, shouting…) always apply; {@link bannedPhrases} layers workspace-specific terms on top — typically
 * derived from the campaign brief's constraints via `profileFromBrief` in the barrel (#588 linkage).
 */
export interface BrandVoiceProfile {
  /** Extra phrases this brand forbids (case-insensitive substring match). Each match is a high-severity finding. */
  bannedPhrases: string[];
}

/** A profile with no workspace-specific banned phrases — only the built-in off-brand lexicons apply. */
export const EMPTY_VOICE_PROFILE: BrandVoiceProfile = { bannedPhrases: [] };

interface LexiconRule {
  kind: VoiceFindingKind;
  severity: VoiceSeverity;
  label: string;
  pattern: RegExp;
}

/**
 * The built-in off-brand lexicon. Patterns are case-insensitive and deliberately broad so lightly-varied
 * phrasing still trips them. These encode the generic "AI-slop / hype / clickbait" markers that made the
 * runaway session's output read as junk regardless of any specific brand voice.
 */
const LEXICON: readonly LexiconRule[] = [
  // --- clickbait: engagement-bait phrasing no credible brand ships --------------------------------------
  {
    kind: "clickbait",
    severity: "high",
    label: "clickbait phrasing",
    pattern:
      /\byou\s+won'?t\s+believe\b|\bthis\s+one\s+(weird\s+)?trick\b|\bmind[\s-]?blowing\b|\bjaw[\s-]?dropping\b|\bshocking\b|\bthe\s+secret\s+(that|to)\b|\bnumber\s+\d+\s+will\s+(shock|surprise)\b/i,
  },
  // --- false-guarantee: absolute promises that are both off-brand and legally risky ---------------------
  {
    kind: "false-guarantee",
    severity: "high",
    label: "absolute guarantee / risk-free promise",
    pattern:
      /\b(100%\s+)?guaranteed?\b|\brisk[\s-]?free\b|\bno\s+risk\b|\bzero\s+risk\b|\bcompletely\s+free\b|\bguarantee\s+results\b/i,
  },
  // --- hype: superlative / buzzword slop ----------------------------------------------------------------
  {
    kind: "hype",
    severity: "medium",
    label: "hype / buzzword language",
    pattern:
      /\brevolutionary\b|\bgame[\s-]?chang(er|ing)\b|\bworld'?s\s+best\b|\bbest[\s-]?in[\s-]?class\b|\bcutting[\s-]?edge\b|\bnext[\s-]?gen(eration)?\b|\bunparalleled\b|\bparadigm\s+shift\b|\bsupercharge\b|\bturbocharge\b|\bsynerg(y|ies|istic)\b|\bdisrupt(ive|ing)?\b|\bunlock\s+(the\s+)?(power|potential)\b|\b10x\b/i,
  },
  // --- shouting: 3+ exclamation marks in a row is a yelling tell -----------------------------------------
  {
    kind: "shouting",
    severity: "low",
    label: "excessive exclamation (shouting)",
    pattern: /!{3,}/,
  },
];

/** Collapse whitespace, trim, and truncate an excerpt for display. Hostile content stays inert (rendered as data). */
function excerpt(value: string, max = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/** Escape a user-supplied banned phrase so it is matched literally inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count emoji-range code points in the text (pictographic + dingbat + transport/symbol blocks). */
function emojiCount(text: string): number {
  const matches = text.match(/[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{2b00}-\u{2bff}]/gu);
  return matches ? matches.length : 0;
}

/** Words of length ≥ 4 written in ALL CAPS, excluding common acronyms a brand legitimately uses. */
const ALLOWED_CAPS = new Set(["FAQ", "FAQS", "HTTP", "HTTPS", "JSON", "HTML", "API", "APIS", "SaaS", "SEO"]);
function shoutingWords(text: string): string[] {
  const words = text.match(/\b[A-Z][A-Z0-9]{3,}\b/g) ?? [];
  return words.filter((w) => !ALLOWED_CAPS.has(w));
}

/** The emoji count at which density tips from "a tasteful accent" into "spam" (one low-severity finding). */
export const EMOJI_SPAM_THRESHOLD = 4;
/** The ALL-CAPS word count at which shouting becomes a finding. */
export const SHOUTING_WORD_THRESHOLD = 3;

/**
 * Check a draft against a brand-voice profile. Pure + total. Returns the explainable score plus every
 * off-brand signal found. An empty / non-string draft scores {@link MAX_VOICE_SCORE} with no findings — the
 * gate, not the voice checker, decides that an empty draft is unpublishable (the checker only judges tone of
 * what is there). Over-reports by design.
 */
export function checkBrandVoice(
  content: string,
  profile: BrandVoiceProfile = EMPTY_VOICE_PROFILE,
): VoiceResult {
  const findings: VoiceFinding[] = [];
  if (typeof content !== "string" || content.length === 0) {
    return { score: MAX_VOICE_SCORE, worstSeverity: null, findings };
  }

  // Workspace-specific banned phrases first (highest severity, most specific to this brand).
  for (const raw of profile.bannedPhrases ?? []) {
    if (typeof raw !== "string") continue;
    const phrase = raw.trim();
    if (!phrase) continue;
    const match = new RegExp(escapeRegExp(phrase), "i").exec(content);
    if (match) {
      findings.push({
        kind: "banned-phrase",
        severity: "high",
        label: `uses a phrase the brand brief forbids ("${excerpt(phrase, 60)}")`,
        excerpt: excerpt(match[0]),
      });
    }
  }

  // Built-in off-brand lexicon.
  for (const rule of LEXICON) {
    const match = rule.pattern.exec(content);
    if (match) {
      findings.push({ kind: rule.kind, severity: rule.severity, label: rule.label, excerpt: excerpt(match[0]) });
    }
  }

  // Density checks: shouting (ALL CAPS) and emoji spam.
  const caps = shoutingWords(content);
  if (caps.length >= SHOUTING_WORD_THRESHOLD) {
    findings.push({
      kind: "shouting",
      severity: "low",
      label: `${caps.length} ALL-CAPS words read as shouting`,
      excerpt: excerpt(caps.slice(0, 6).join(" ")),
    });
  }
  const emojis = emojiCount(content);
  if (emojis >= EMOJI_SPAM_THRESHOLD) {
    findings.push({
      kind: "emoji-spam",
      severity: "low",
      label: `${emojis} emoji read as spam / unprofessional`,
      excerpt: "<emoji density>",
    });
  }

  const penalty = findings.reduce((sum, f) => sum + VOICE_PENALTY[f.severity], 0);
  const score = Math.max(0, MAX_VOICE_SCORE - penalty);
  const worstSeverity = worstOf(findings);
  return { score, worstSeverity, findings };
}

const SEVERITY_RANK: Record<VoiceSeverity, number> = { low: 1, medium: 2, high: 3 };

/** The most severe severity across a finding list, or `null` when empty. */
export function worstOf(findings: readonly VoiceFinding[]): VoiceSeverity | null {
  let worst: VoiceSeverity | null = null;
  for (const f of findings) {
    if (worst === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}
