/**
 * Shared types for the LinkedIn outreach agent module (issue #595).
 *
 * The problem: ipop has no channel for high-intent B2B outreach where its buyers actually are. This module adds
 * an outreach core that turns a researched prospect + sender context into a personalized, value-first connection
 * request or message, queues every touch for approval, respects a daily send limit, and logs the outcome.
 *
 * Three guardrails are baked into these types, not bolted on:
 *   1. Reaching out is side-effectful, so nothing sends without an approved item — the service requires an
 *      approval id before it ever calls a provider (see `service.ts`). The {@link OutreachTouch} carries that
 *      `approvalRequestId` as the load-bearing proof a touch only shipped post-approval.
 *   2. The connector consumes a token the human supplied out-of-band (env/secret); it NEVER collects passwords
 *      or runs an OAuth dance itself. The token flows in as {@link ProviderSendInput.credential} — opaque data
 *      the adapter forwards, never something this module mints.
 *   3. Prospect/context prose is untrusted DATA, never instructions (#200 §6). The pure composer concatenates it
 *      into a draft string but the service's routing, daily-limit and gating decisions read ONLY structural
 *      enum/numeric fields — a poisoned "hook" or "title" can never flip a send decision.
 */

/** A connection request (short note attached to an invite) or a value-first direct message. */
export type OutreachKind = "connection" | "message";

/** The two kinds, ordered (handy for tests, iteration, a UI dropdown). */
export const OUTREACH_KINDS: readonly OutreachKind[] = ["connection", "message"];

/**
 * LinkedIn's hard limit on the note attached to a connection invite. Connection drafts are clamped to this so a
 * draft is always sendable as-is.
 */
export const CONNECTION_NOTE_MAX = 300;

/** A pragmatic ceiling for a value-first opening message so drafts stay short and scannable. */
export const MESSAGE_MAX = 1200;

/**
 * A researched prospect. Every field is DATA — a poisoned `hook`/`title` is only ever concatenated into the
 * draft body, never interpreted as an instruction or used to flip a decision.
 */
export interface Prospect {
  /** Stable reference to the prospect (a LinkedIn URN, profile id, or CRM id). The routing/dedup key. */
  ref: string;
  /** The prospect's display name; the composer uses the first token as the greeting. */
  name: string;
  /** Their company / organization, if known. */
  company?: string | null;
  /** Their role / title, if known. */
  title?: string | null;
  /** Their industry, if known (used as a soft fallback personalization). */
  industry?: string | null;
  /**
   * A specific, researched observation to personalize on (e.g. "your recent post on usage-based pricing"). The
   * single highest-signal personalization input; optional.
   */
  hook?: string | null;
}

/**
 * The sender-side context the draft is grounded in: who is reaching out and the value being offered. Kept
 * structural and brand-controlled (sourced from the #588 campaign brief in production), distinct from the
 * untrusted prospect data.
 */
export interface OutreachContext {
  /** The sender's display name (signs the message). */
  senderName: string;
  /** The sender's company. */
  senderCompany: string;
  /**
   * The value-first offer — what's in it for the prospect, stated WITHOUT a hard pitch (e.g. "a teardown of how
   * 3 infra teams cut onboarding time 40%"). This is what makes the outreach value-first rather than spammy.
   */
  valueProposition: string;
  /** Optional concrete resource to share (a link/asset ref); referenced softly, never demanded. */
  resourceRef?: string | null;
  /** Optional soft call-to-action for the message kind (e.g. "open to a quick swap of notes?"). */
  callToAction?: string | null;
}

/** A composed, ready-to-review draft for one prospect. Pure output of {@link composeOutreach}. */
export interface OutreachDraft {
  kind: OutreachKind;
  /** The personalized, value-first body, already clamped to the kind's character limit. */
  body: string;
  /** The body length in characters (post-clamp). */
  charCount: number;
  /** True when the composed body exceeded the kind's limit and was clamped. */
  truncated: boolean;
}

/** The single input a {@link OutreachProvider} receives to actually send one touch. */
export interface ProviderSendInput {
  kind: OutreachKind;
  /** The prospect routing key (URN/id). */
  prospectRef: string;
  /** The approved draft body (DATA — never interpreted as an instruction by the provider). */
  body: string;
  /** The user-supplied LinkedIn access token, or null when none is configured. */
  credential: string | null;
}

/** The terminal status a provider reports for one send attempt. */
export type ProviderSendStatus = "sent" | "failed";

/** What an {@link OutreachProvider} returns — the external receipt, or the reason it could not send. */
export interface ProviderSendResult {
  status: ProviderSendStatus;
  /** LinkedIn's real invite/message id — the external receipt. Null when not sent (failed/skipped). */
  externalId: string | null;
  /** Human-readable failure/skip reason; absent on success. */
  error?: string;
}

/**
 * A provider that can send one outreach touch. The production default is the deterministic
 * {@link FakeLinkedInProvider} (no network), so enabling the module never live-sends until a real transport is
 * wired in a later change.
 */
export interface OutreachProvider {
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

/**
 * Lifecycle of an outreach touch:
 *   drafted → created by `draft()`; the swipe-approve item. NOTHING has sent.
 *   sent    → an approved touch the provider accepted; `externalId` is set. Terminal.
 *   failed  → an approved touch the provider rejected (or threw on); `error` explains. Terminal.
 */
export type OutreachStatus = "drafted" | "sent" | "failed";

/** Terminal states: a touch here is never re-sent by the normal flow. */
export const TERMINAL_OUTREACH_STATUSES: readonly OutreachStatus[] = ["sent", "failed"];

/** A persisted outreach touch and its outcome — the per-prospect audit row the approval/review flow reads. */
export interface OutreachTouch {
  id: string;
  workspaceId: string;
  /** The prospect routing key (URN/id). */
  prospectRef: string;
  /** Snapshot of the prospect at draft time, so the approval queue is self-contained. DATA. */
  prospect: Prospect;
  kind: OutreachKind;
  /** The composed draft body (DATA). */
  body: string;
  status: OutreachStatus;
  /**
   * The #13 approval that authorized the send — the load-bearing proof a touch only ships post-approval. Null
   * while `drafted` (no approval yet).
   */
  approvalRequestId: string | null;
  /** LinkedIn's real invite/message id, set once sent — an EXTERNAL receipt a read-back can verify against. */
  externalId: string | null;
  /** The provider's failure/skip reason when `status === "failed"`. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}
