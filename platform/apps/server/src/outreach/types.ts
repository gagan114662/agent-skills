/**
 * Outreach engine — pure data shapes (#225, ADR-0225). No IO, no clock.
 *
 * The engine consumes two upstream artifacts as DATA: the ranked discovery queue (#222) and the buyer
 * brief (#223). It composes a channel-specific, problem-led message and PARKS it at the #13 gate — it
 * never sends. Two structural safety properties are encoded here and proven by the service:
 *
 *   - #200 (sends are IRREVERSIBLE: deliverability/brand): every send is gated for the owner. A
 *     {@link ComposedMessage} is inert DATA until a human approves the matching #13 request.
 *   - #223 (injection-quarantine end-to-end): the brief is consumed as already-sanitized DATA. The
 *     message RECIPIENT is derived ONLY from structured identity fields (never from read text), and the
 *     compose step is pure DATA→DATA. So a poisoned enrichment read can, at most, place a sanitized
 *     string on an owner-reviewed approval card — it can never change who is contacted or trigger a send.
 */

import type { ServiceKind } from "../onboarding/types.js";
import type { RealWorldToolName } from "../realworld/types.js";

/**
 * The channels the engine can reach a buyer on. Each maps to a #231 real-world tool + the connected
 * account kind that send needs, so the existing tool-surface gate decides availability + what to connect.
 */
export const OUTREACH_CHANNELS = ["email", "linkedin", "x"] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export function isOutreachChannel(value: unknown): value is OutreachChannel {
  return typeof value === "string" && (OUTREACH_CHANNELS as readonly string[]).includes(value);
}

/**
 * The value-prop message variants the engine A/B/Cs (the angles Wispr iterates — time saved vs.
 * productivity vs. cost). A winner is concluded ONLY from external receipts; the projection is UNVERIFIED.
 */
export const VALUE_PROP_VARIANTS = ["time_saved", "productivity", "cost"] as const;
export type ValuePropVariant = (typeof VALUE_PROP_VARIANTS)[number];

export function isValuePropVariant(value: unknown): value is ValuePropVariant {
  return typeof value === "string" && (VALUE_PROP_VARIANTS as readonly string[]).includes(value);
}

/** Lifecycle of one outreach message. `drafted` → (`blocked` | `pending_approval`) → `sent` | `failed`. */
export const OUTREACH_MESSAGE_STATUSES = [
  "drafted",
  "blocked",
  "pending_approval",
  "sent",
  "failed",
] as const;
export type OutreachMessageStatus = (typeof OUTREACH_MESSAGE_STATUSES)[number];

/**
 * The kinds of EXTERNAL receipt that conclude an experiment (premortem #200 §2: metrics are external
 * receipts only). A reply, a booked meeting, a signup — each must carry a non-empty `externalRef` (the
 * proof). No self-reported/projected metric ever lands here.
 */
export const OUTREACH_RECEIPT_KINDS = ["reply", "meeting", "signup"] as const;
export type OutreachReceiptKind = (typeof OUTREACH_RECEIPT_KINDS)[number];

export function isOutreachReceiptKind(value: unknown): value is OutreachReceiptKind {
  return typeof value === "string" && (OUTREACH_RECEIPT_KINDS as readonly string[]).includes(value);
}

/** The #231 tool a channel sends through (drives the connected-account gate). */
export function channelTool(channel: OutreachChannel): RealWorldToolName {
  return channel === "email" ? "send_email" : "post_social";
}

/** The connected-account kind a channel needs (mirrors the #231 tool spec). */
export function channelAccountKind(channel: OutreachChannel): ServiceKind {
  return channel === "email" ? "esp" : "ad_account";
}

/**
 * A composed, channel-specific message — pure DATA. `recipientRef` is an OPAQUE structural reference
 * (`<channel>:<buyerContactId>`), never a raw address and never derived from brief text; the connected
 * channel resolves the real address at send time. `recipientLabel` is a human label for the approval
 * card built from structured identity only (no PII). The brief's read-derived `evidence` is deliberately
 * NOT placed in the body — it travels only as approval-card context for the owner to verify grounding.
 */
export interface ComposedMessage {
  prospectKey: string;
  channel: OutreachChannel;
  variant: ValuePropVariant;
  subject: string;
  body: string;
  recipientRef: string;
  recipientLabel: string;
  /** The PQL signal kind(s) that triggered the channel/message choice (audit; from #222). */
  signalKinds: string[];
  /** Grounding shown to the owner on the approval card — sanitized DATA, never injected into the body. */
  groundingEvidence: string[];
}

/** A persisted outreach message (one row per attempt; the audit + experiment denominator). */
export interface OutreachMessageRecord {
  id: string;
  workspaceId: string;
  ideaId: string | null;
  prospectKey: string;
  accountId: string | null;
  buyerBriefId: string | null;
  channel: OutreachChannel;
  variant: ValuePropVariant;
  signalKind: string | null;
  subject: string;
  body: string;
  recipientLabel: string;
  recipientRef: string;
  /** Groups messages into one experiment (per idea + channel) so variants are compared like-for-like. */
  experimentKey: string;
  status: OutreachMessageStatus;
  approvalRequestId: string | null;
  provider: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A persisted EXTERNAL receipt — the only thing that moves an experiment + the GTM pipeline. */
export interface OutreachReceiptRecord {
  id: string;
  workspaceId: string;
  messageId: string;
  kind: OutreachReceiptKind;
  /** The proof the receipt is external (a provider event id, a calendar link, a signup id). Non-empty. */
  externalRef: string;
  replyBody: string | null;
  replyFrom: string | null;
  replySubject: string | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface OutreachReplyThread {
  receipt: OutreachReceiptRecord;
  message: OutreachMessageRecord;
}
