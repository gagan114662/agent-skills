/**
 * Reach — ipop's autonomous OUTBOUND demand-gen department (#280). Where the seven inbound/owned-media
 * departments wait for prospects to arrive, Reach goes and finds them: it learns an ICP from the
 * workspace domain + founder console, finds net-new prospects with LIVE buying signals through a
 * pluggable {@link ProspectSource}, scores + dedupes them against everyone we've already touched,
 * personalises a 1:1 opener around what the prospect just did, sends it through a {@link
 * ReachChannelAdapter} under per-domain rate caps + opt-out/suppression, enrols it in a cadence,
 * measures the result, and self-tunes the next batch. This file is the pure type + constant vocabulary
 * the whole loop shares (no IO).
 *
 * The hard rails (kept identical to the rest of the platform):
 *   - MONEY-ONLY gating — buying paid data credits is a money action (gated, #13); SENDING a marketing
 *     message is NOT (autonomous, under caps). See {@link ProspectSource.costPerProspectCents}.
 *   - INJECTION-QUARANTINE — a buying signal's free text (what the prospect "just did") is untrusted
 *     DATA. It is sanitised before it ever lands in an opener and it can NEVER change who is contacted
 *     or trigger a send; the send target comes only from a prospect's STRUCTURED contact field.
 *   - SUPPRESSION + per-domain rate caps are enforced on every channel (reusing the #189 primitives).
 *   - No scraping, no list-buying: prospects come only from permitted data-provider APIs.
 */

/** The channels Reach can send through. Email is the live auto-send channel; LinkedIn is permitted-API only. */
export const REACH_CHANNELS = ["email", "linkedin"] as const;
export type ReachChannel = (typeof REACH_CHANNELS)[number];
export function isReachChannel(value: string): value is ReachChannel {
  return (REACH_CHANNELS as readonly string[]).includes(value);
}

/** The pluggable prospect-data providers behind the {@link ProspectSource} seam. `imported` is the default. */
export const PROSPECT_SOURCE_KINDS = ["imported", "mock", "clay", "lusha", "vibe"] as const;
export type ProspectSourceKind = (typeof PROSPECT_SOURCE_KINDS)[number];
export function isProspectSourceKind(value: string): value is ProspectSourceKind {
  return (PROSPECT_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * The buying-signal vocabulary — the LIVE event that makes a prospect worth contacting NOW (the thing the
 * opener is built around). Closed enum so the signal's untrusted free text never becomes the routing key.
 */
export const REACH_SIGNAL_KINDS = [
  "funding_round",
  "hiring_surge",
  "tech_adoption",
  "pricing_page_visit",
  "content_engagement",
  "job_change",
  "competitor_switch",
] as const;
export type ReachSignalKind = (typeof REACH_SIGNAL_KINDS)[number];
export function isReachSignalKind(value: string): value is ReachSignalKind {
  return (REACH_SIGNAL_KINDS as readonly string[]).includes(value);
}

/**
 * The value-prop angle an opener is written from (the A/B/C lever self-tune turns). Distinct from the
 * #225 outreach variants because Reach is cold-outbound: it leads with the prospect's pain, not ours.
 */
export const REACH_VARIANTS = ["pain", "outcome", "social_proof"] as const;
export type ReachVariant = (typeof REACH_VARIANTS)[number];
export function isReachVariant(value: string): value is ReachVariant {
  return (REACH_VARIANTS as readonly string[]).includes(value);
}

/** The outcome of trying to send one message on one channel. */
export const REACH_SEND_STATUSES = [
  "sent", // left the building (or recorded-only under a dry-run provider)
  "queued", // channel has no permitted send path yet (LinkedIn) — held, never faked
  "suppressed", // recipient is on the opt-out/suppression list
  "rate_limited", // per-domain daily cap reached
  "skipped", // no deliverable address / compliance gap on this channel
  "failed", // the provider rejected the send
] as const;
export type ReachSendStatus = (typeof REACH_SEND_STATUSES)[number];

/** External engagement receipts — the ONLY source of measurement truth (each carries an external ref). */
export const REACH_RECEIPT_KINDS = ["open", "reply", "booked", "bounce", "complaint"] as const;
export type ReachReceiptKind = (typeof REACH_RECEIPT_KINDS)[number];
export function isReachReceiptKind(value: string): value is ReachReceiptKind {
  return (REACH_RECEIPT_KINDS as readonly string[]).includes(value);
}

/** The lifecycle of a prospect's cadence enrolment. */
export const REACH_ENROLLMENT_STATUSES = ["imported", "active", "completed", "replied", "opted_out"] as const;
export type ReachEnrollmentStatus = (typeof REACH_ENROLLMENT_STATUSES)[number];

/** The outcome of one cron batch run. */
export const REACH_RUN_STATUSES = [
  "completed", // ran end-to-end (sourced, sent, measured)
  "awaiting_data_funding", // a paid source needs an owner-approved data-credit spend first (money-gated)
  "skipped", // disabled / nothing to do this run
] as const;
export type ReachRunStatus = (typeof REACH_RUN_STATUSES)[number];

/**
 * The Ideal Customer Profile (#280 step 1). Learned from the workspace domain + founder console, refined
 * by self-tune. Pure data; every field is a structured filter, never free instruction text.
 */
export interface Icp {
  /** The workspace's own domain — the seed the ICP is learned from. */
  domain: string;
  /** Industries to target (e.g. "saas", "fintech"). */
  industries: string[];
  /** Buyer titles/roles to target (e.g. "head of growth", "founder"). */
  roles: string[];
  /** Company-size buckets to target (e.g. "11-50", "51-200"). */
  companySizes: string[];
  /** Value-prop keywords that describe the problem we solve (used to score fit + flavour the opener). */
  keywords: string[];
  /** Which buying signals we act on, highest-priority first (self-tune reorders this). */
  signalKinds: ReachSignalKind[];
}

/** A LIVE buying signal attached to a prospect. `summary` is untrusted text — sanitised before any use. */
export interface BuyingSignal {
  kind: ReachSignalKind;
  /** Free-text description of what the prospect just did. UNTRUSTED — quarantined before personalisation. */
  summary: string;
  /** When the signal was observed (ms epoch); drives recency scoring. */
  observedAtMs: number;
}

/**
 * A prospect as returned by a {@link ProspectSource}. The contact fields are STRUCTURED (the only thing
 * that can ever become a send target); `signals` carry the untrusted free text.
 */
export interface RawProspect {
  fullName: string;
  title: string;
  company: string;
  companyDomain: string;
  /** Work email, or null when the source only has a LinkedIn handle (then email is impossible → LinkedIn). */
  email: string | null;
  /** LinkedIn member URL/URN, or null. */
  linkedinUrl: string | null;
  industry: string | null;
  companySize: string | null;
  signals: BuyingSignal[];
  /** Which provider surfaced this prospect. */
  sourceKind: ProspectSourceKind;
}

/** A prospect after fit/recency scoring. Carries the single freshest signal the opener is built around. */
export interface ScoredProspect {
  prospect: RawProspect;
  /** Stable dedupe key — the normalised email, else the LinkedIn URL, else name|company (never PII-leaky text). */
  contactKey: string;
  /** 0–100 blend of ICP fit + signal strength/recency. Higher = contact sooner. */
  score: number;
  /** Why it scored what it did (audit; never shown to the prospect). */
  scoreReasons: string[];
  /** The freshest qualifying signal — what the opener references. null when the prospect has no live signal. */
  freshSignal: BuyingSignal | null;
}

/** A composed, ready-to-send 1:1 message. The send target is `toAddress` — a STRUCTURED field, never read text. */
export interface ReachMessage {
  contactKey: string;
  channel: ReachChannel;
  /** The structured send target (email address, or LinkedIn URN). NEVER derived from signal text. */
  toAddress: string;
  /** Human label for the audit/approval surface (e.g. "Jane Doe · Acme"). No instruction text. */
  recipientLabel: string;
  /** Email subject ("" on LinkedIn). */
  subject: string;
  body: string;
  variant: ReachVariant;
  /** The signal the opener was built around (for measurement attribution), or null. */
  signalKind: ReachSignalKind | null;
}

/** The result of dispatching one {@link ReachMessage} through a channel adapter. */
export interface ReachSendOutcome {
  status: ReachSendStatus;
  channel: ReachChannel;
  /** Provider message id when sent, else null. */
  externalId: string | null;
  /** One-line explanation (e.g. "dry-run", "no permitted LinkedIn send path", "suppressed"). */
  detail: string;
}
