/**
 * Outreach engine — pure core (#225, ADR-0225). No IO, no clock, no randomness. Two jobs:
 *
 *   1. Compose a channel-specific, PROBLEM-LED message from the buyer brief (#223) + the PQL signal
 *      (#222). "Solve their problem, don't sell the product": the opener names the buyer's pain; the
 *      value-prop variant frames the benefit (time saved / productivity / cost); the product is named
 *      once, lightly. The RECIPIENT is built ONLY from structured identity fields — never from read
 *      text — and the brief's read-derived `evidence` is kept OUT of the body (it travels as approval-
 *      card grounding). So a poisoned enrichment read cannot change who is contacted or what is sent.
 *
 *   2. Conclude message experiments. A winner is decided ONLY from external receipts (replies, meetings,
 *      signups); the per-variant conversion rate is a PROJECTION, labeled UNVERIFIED, never the sole driver.
 */

import { UNVERIFIED_LABEL } from "../discovery/contract.js";
import {
  OUTREACH_CHANNELS,
  VALUE_PROP_VARIANTS,
  type OutreachChannel,
  type OutreachSpamRisk,
  type ValuePropVariant,
  type ComposedMessage,
} from "./types.js";

// ---------------------------------------------------------------------------------------------------
// Sanitizers (defense-in-depth — the real defense is structural: the recipient is never read-derived).
// ---------------------------------------------------------------------------------------------------

const MAX_SUBJECT_CHARS = 120;
const MAX_BODY_CHARS = 700;
const MAX_LABEL_CHARS = 140;
const MAX_EVIDENCE_CHARS = 200;
const MAX_GROUNDING = 3;
const MAX_SPAM_REASONS = 8;

/** Strip control chars, collapse whitespace, trim, and cap length. Quoted DATA, never executed. */
export function sanitizeLine(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    // Drop ASCII control chars (code points < 32) and DEL — they have no place in a message line and
    // are a classic injection/format-break vector in scraped text.
    out += ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------------------------------
// Spam / phishing risk scoring (#931). Pure DATA->DATA so routes, services, and tests all see one truth.
// ---------------------------------------------------------------------------------------------------

const SPAM_TRIGGER_PATTERNS: Array<[RegExp, string, number]> = [
  [
    /\b(act now|limited time|urgent|winner|guaranteed|risk[- ]?free|free trial|click here)\b/i,
    "spam trigger language",
    25,
  ],
  [
    /\b(make money fast|double your revenue|no obligation|exclusive offer)\b/i,
    "promotional trigger language",
    20,
  ],
];

const PHISHING_PATTERNS: Array<[RegExp, string, number]> = [
  [
    /\b(confirm|verify|update)\s+(your\s+)?(account|password|payment|billing)\b/i,
    "credential-verification phrasing",
    35,
  ],
  [
    /\b(lose access|account suspended|security alert|unusual activity)\b/i,
    "account-threat phrasing",
    35,
  ],
  [/\b(password|one[- ]?time code|2fa|mfa|wire transfer)\b/i, "sensitive-action phrasing", 25],
];

const HOMOGLYPH_PATTERNS: Array<[RegExp, string, number]> = [
  [/\b[a-z]*[0@$!][a-z]*\b/i, "homoglyph substitution", 25],
  [/\b(?:acc0unt|l0gin|passw0rd|verif[y1]|b[i1]ll[i1]ng)\b/i, "credential homoglyph", 30],
];

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason) && reasons.length < MAX_SPAM_REASONS) reasons.push(reason);
}

function capsRatio(text: string): number {
  const letters = [...text].filter((ch) => /[A-Za-z]/.test(ch));
  if (letters.length < 8) return 0;
  const caps = letters.filter((ch) => ch >= "A" && ch <= "Z").length;
  return caps / letters.length;
}

export function checkSpamRisk(input: { subject?: string; body: string }): OutreachSpamRisk {
  const subject = sanitizeLine(input.subject ?? "", MAX_SUBJECT_CHARS);
  const body = sanitizeLine(input.body, MAX_BODY_CHARS);
  const joined = `${subject} ${body}`.trim();
  let score = 0;
  const reasons: string[] = [];

  for (const [pattern, reason, weight] of SPAM_TRIGGER_PATTERNS) {
    if (pattern.test(joined)) {
      score += weight;
      addReason(reasons, reason);
    }
  }
  for (const [pattern, reason, weight] of PHISHING_PATTERNS) {
    if (pattern.test(joined)) {
      score += weight;
      addReason(reasons, reason);
    }
  }
  for (const [pattern, reason, weight] of HOMOGLYPH_PATTERNS) {
    if (pattern.test(joined)) {
      score += weight;
      addReason(reasons, reason);
    }
  }

  const subjectCaps = capsRatio(subject);
  const bodyCaps = capsRatio(body);
  if (subjectCaps >= 0.65) {
    score += 25;
    addReason(reasons, "all-caps subject");
  }
  if (bodyCaps >= 0.45) {
    score += 15;
    addReason(reasons, "all-caps body");
  }
  if (/[!?]{3,}/.test(joined)) {
    score += 10;
    addReason(reasons, "excessive punctuation");
  }

  const boundedScore = Math.min(100, score);
  const level = boundedScore >= 80 ? "block" : boundedScore >= 35 ? "review" : "clean";
  return { score: boundedScore, level, reasons };
}

// ---------------------------------------------------------------------------------------------------
// Channel + variant selection (auto-select per PQL signal — Wispr's "the channel that works").
// ---------------------------------------------------------------------------------------------------

/**
 * The channel preference order for a set of PQL signal kinds (#222). A role-identification signal leans
 * to a professional network (LinkedIn); an in-product/intent signal leans to direct email. The service
 * intersects this with the channels whose accounts are actually connected, so an unconnected channel is
 * never chosen. Pure + total (always returns all channels in some order).
 */
export function channelPreference(signalKinds: readonly string[]): OutreachChannel[] {
  if (signalKinds.includes("role_identified")) {
    return ["linkedin", "email", "x"];
  }
  return ["email", "linkedin", "x"];
}

/** The first preferred channel whose account is connected, or null when none of them are. */
export function selectChannel(
  signalKinds: readonly string[],
  available: ReadonlySet<OutreachChannel>,
): OutreachChannel | null {
  for (const c of channelPreference(signalKinds)) {
    if (available.has(c)) return c;
  }
  return null;
}

/** FNV-1a 32-bit hash — deterministic variant assignment (no Math.random, stable across runs). */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministically assign a prospect to a value-prop variant (even spread, stable per prospect). The
 * same prospect always gets the same variant, so the experiment isn't polluted by re-rolls.
 */
export function selectVariant(prospectKey: string): ValuePropVariant {
  return VALUE_PROP_VARIANTS[fnv1a(prospectKey) % VALUE_PROP_VARIANTS.length] ?? "time_saved";
}

// ---------------------------------------------------------------------------------------------------
// Compose (problem-led).
// ---------------------------------------------------------------------------------------------------

/** The buyer facts the composer reads — all structured DATA from #223 (no live reads happen here). */
export interface ComposeBuyer {
  buyerName: string;
  buyerTitle: string;
  buyerRole: string;
  /** Stable opaque contact id from #223 — the recipient ref is derived from THIS, never from text. */
  buyerContactId: string;
  accountId: string | null;
  accountName: string;
  /** The account's pain area (#222/#223) — the problem we lead with. Structured DATA. */
  painArea: string;
  /** Bounded topic tags from actually-read sources (#223) — already sanitized; re-sanitized here. */
  caresAbout: string[];
  /** Hooks from #223: `angle` is templated from structured fields; `evidence` is quoted read DATA. */
  hooks: { angle: string; evidence: string }[];
}

export interface ComposeInput {
  prospectKey: string;
  signalKinds: string[];
  channel: OutreachChannel;
  variant: ValuePropVariant;
  buyer: ComposeBuyer;
  /** The venture's product — named once, lightly. We sell the outcome, not the product. */
  productName: string;
  /**
   * An optional trackable pay link (Leads Centre GAP 3, ADR-0401). When present, a single clean
   * "Start here: <url>" line is appended to the body so a reached human has a real way to pay. The URL is
   * ipop's OWN minted #386 tracked link (inbound collection, never a charge) — not read-derived — so it is
   * appended only when the (gated) caller supplies one. Absent ⇒ the body is byte-for-byte unchanged.
   */
  payLinkUrl?: string;
}

/** The single line that carries the pay link into the body — fixed ipop voice, never artifact-derived. */
const PAY_LINK_PREFIX = "Start here:";

/**
 * True iff `url` is a safe http(s) absolute URL to append to a message body. The URL is ipop's own minted
 * link, but we still validate the scheme so a malformed/relative value never lands in the body verbatim.
 */
function isSafePayLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** The benefit sentence per value-prop variant — frames solving the problem, not the feature list. */
function valuePropLine(variant: ValuePropVariant, productName: string, problem: string): string {
  const product = productName.trim() || "we";
  switch (variant) {
    case "time_saved":
      return `Teams using ${product} claw back hours a week on ${problem} instead of grinding through it by hand.`;
    case "productivity":
      return `${product} lets your team get more done on ${problem} without adding headcount.`;
    case "cost":
      return `${product} cuts what ${problem} costs you today — same output, lower spend.`;
  }
}

/**
 * Compose a problem-led, channel-appropriate message. PURE: same inputs → same message, no IO. The
 * opener names the buyer's problem; the variant frames the benefit; a soft, channel-fitting CTA closes.
 * The recipient is structural (`<channel>:<buyerContactId>`); read-derived evidence stays out of the body.
 */
export function composeMessage(input: ComposeInput): ComposedMessage {
  const { buyer } = input;
  const name = sanitizeLine(buyer.buyerName, 80) || "there";
  const account = sanitizeLine(buyer.accountName, 80) || "your team";
  // The problem we lead with: the most specific signal we have — a topic the buyer cares about, else the
  // account's pain area, else a role-generic fallback. All structured DATA (re-sanitized defensively).
  const topic = sanitizeLine(buyer.caresAbout[0] ?? "", 80);
  const painArea = sanitizeLine(buyer.painArea, 80);
  const problem = topic || painArea || "the work that keeps piling up";

  const opener = `I noticed ${account} is likely wrestling with ${problem}.`;
  const value = sanitizeLine(valuePropLine(input.variant, input.productName, problem), 240);
  const isEmail = input.channel === "email";
  const cta = isEmail ? "Open to a 15-minute look at whether it'd help?" : "Worth a quick chat?";

  const bodyParts = isEmail
    ? [`Hi ${name},`, opener, value, cta]
    : [`Hi ${name} — ${opener}`, value, cta];
  const prose = sanitizeLine(bodyParts.join(" "), MAX_BODY_CHARS);

  // Append a single clean pay-link line when one is supplied (GAP 3). The URL is ipop's own minted #386
  // tracked link — appended AFTER the prose cap so the link is never truncated, then re-capped together. The
  // pay-link line is its own clause; the URL is not run through sanitizeLine (which would collapse it) but is
  // scheme-validated. Absent/invalid ⇒ the body is byte-for-byte unchanged.
  const payLinkUrl = input.payLinkUrl?.trim();
  const body =
    payLinkUrl && isSafePayLinkUrl(payLinkUrl)
      ? `${prose} ${PAY_LINK_PREFIX} ${payLinkUrl}`
      : prose;

  const subject = isEmail ? sanitizeLine(`${problem} at ${account}`, MAX_SUBJECT_CHARS) : "";
  const spamRisk = checkSpamRisk({ subject, body });

  const roleOrTitle = sanitizeLine(buyer.buyerTitle || buyer.buyerRole, 60);
  const recipientLabel = sanitizeLine(
    `${name}${roleOrTitle ? ` (${roleOrTitle})` : ""} @ ${account}`,
    MAX_LABEL_CHARS,
  );

  const groundingEvidence = buyer.hooks
    .map((h) => sanitizeLine(h.evidence, MAX_EVIDENCE_CHARS))
    .filter((e) => e.length > 0)
    .slice(0, MAX_GROUNDING);

  return {
    prospectKey: input.prospectKey,
    channel: input.channel,
    variant: input.variant,
    subject,
    body,
    // Structural recipient — derived from the opaque contact id, NEVER from read text. This is the line
    // that makes enrichment injection inert: whatever a poisoned profile says, the message goes here.
    recipientRef: `${input.channel}:${sanitizeLine(buyer.buyerContactId, 80)}`,
    recipientLabel,
    signalKinds: input.signalKinds.map((s) => sanitizeLine(s, 40)).filter((s) => s.length > 0),
    groundingEvidence,
    spamRisk,
  };
}

// ---------------------------------------------------------------------------------------------------
// Experiments — winners from external receipts only (premortem #200 §2).
// ---------------------------------------------------------------------------------------------------

/** Raw per-variant counts (the experiment denominator + external receipts). */
export interface VariantTally {
  variant: ValuePropVariant;
  sent: number;
  replies: number;
  meetings: number;
  signups: number;
}

export interface VariantResult extends VariantTally {
  /** replies + meetings + signups — EXTERNAL receipts only. This is fact, the basis for the winner. */
  verifiedConversions: number;
  /** verifiedConversions / sent — a PREDICTION of future performance. Never the sole decision driver. */
  projectedConversionRate: number;
  /** Always "UNVERIFIED": the rate is a projection even though its inputs are real receipts. */
  projectionLabel: typeof UNVERIFIED_LABEL;
}

export interface ExperimentConclusion {
  experimentKey: string;
  status: "running" | "concluded";
  /** The winning variant — set ONLY when external receipts give a strict, unambiguous lead. */
  winner: ValuePropVariant | null;
  variants: VariantResult[];
  totalSent: number;
  totalVerifiedConversions: number;
  note: string;
}

function toResult(t: VariantTally): VariantResult {
  const verifiedConversions = t.replies + t.meetings + t.signups;
  return {
    ...t,
    verifiedConversions,
    projectedConversionRate: t.sent > 0 ? verifiedConversions / t.sent : 0,
    projectionLabel: UNVERIFIED_LABEL,
  };
}

/**
 * Conclude one experiment from its per-variant tallies. The winner is the variant with the STRICTLY
 * highest external-receipt count; a zero-receipt or tied experiment stays `running` with no winner —
 * we never declare a winner off projections or a coin-flip. Missing variants are filled with zeros so
 * every experiment reports all three angles. Pure + total.
 */
export function concludeExperiment(
  experimentKey: string,
  tallies: readonly VariantTally[],
): ExperimentConclusion {
  const byVariant = new Map<ValuePropVariant, VariantTally>();
  for (const t of tallies) byVariant.set(t.variant, t);
  const variants = VALUE_PROP_VARIANTS.map((v) =>
    toResult(byVariant.get(v) ?? { variant: v, sent: 0, replies: 0, meetings: 0, signups: 0 }),
  );

  const totalSent = variants.reduce((a, r) => a + r.sent, 0);
  const totalVerifiedConversions = variants.reduce((a, r) => a + r.verifiedConversions, 0);

  if (totalVerifiedConversions === 0) {
    return {
      experimentKey,
      status: "running",
      winner: null,
      variants,
      totalSent,
      totalVerifiedConversions,
      note: "awaiting external receipts (replies / meetings / signups)",
    };
  }

  const max = Math.max(...variants.map((r) => r.verifiedConversions));
  const leaders = variants.filter((r) => r.verifiedConversions === max);
  const winner = leaders.length === 1 ? leaders[0] : undefined;
  if (!winner) {
    return {
      experimentKey,
      status: "running",
      winner: null,
      variants,
      totalSent,
      totalVerifiedConversions,
      note: "tied on external receipts — needs more signal before concluding",
    };
  }

  return {
    experimentKey,
    status: "concluded",
    winner: winner.variant,
    variants,
    totalSent,
    totalVerifiedConversions,
    note: `concluded from external receipts: ${winner.variant} leads with ${max}`,
  };
}

/** All channels as a set helper for tests/wiring. */
export const ALL_CHANNELS: ReadonlySet<OutreachChannel> = new Set(OUTREACH_CHANNELS);
