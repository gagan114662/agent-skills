import { isExternalReceipt, type ExternalReceipt } from "../action-contract/receipt.js";
import type { OutboundChannel } from "../outbound-channel/constants.js";

/**
 * First-real-customer proof gate (#908, bridging #395).
 *
 * The child tickets can all be implemented while the epic is still unproven: CSV import may work, Postmark
 * may be wired, replies may be stored, and booking links may render, yet no clean deployment has produced a
 * real stranger conversation. This pure gate is the executable close bar for the epic. It accepts only
 * evidence that proves the ordered funnel spine, and it deliberately rejects mock/dry-run/example evidence.
 */

export type FirstCustomerRequirement =
  | "real_prospect_source"
  | "real_outbound_delivery"
  | "reply_ingested_visible"
  | "inbound_qualified_routed"
  | "booking_or_trial_link";

export interface ProspectSourceProof {
  readonly kind: "csv_import" | "json_import" | "owner_connected_source";
  readonly importedCount: number;
  readonly fabricatedCount: number;
  /** The campaign/customer ref minted for this buyer; must follow the prospect through send, lead, and booking. */
  readonly trackingRef: string;
  readonly sampleEmails: readonly string[];
}

export interface OutboundDeliveryProof {
  readonly channel: OutboundChannel;
  readonly provider: string;
  readonly receipt: ExternalReceipt;
  readonly recipient: string;
  readonly approvalRequestId: string;
  readonly trackingRef: string;
}

export interface ReplyProof {
  readonly providerThreadId: string;
  readonly replyMessageId: string;
  readonly replyFrom: string;
  readonly visibleInLeadTimeline: boolean;
  readonly visibleInInbox: boolean;
}

export interface InboundRouteProof {
  readonly leadId: string;
  readonly leadEmail: string;
  readonly rule: "inbound_lead";
  readonly trackingRef: string;
  readonly autoQualified: boolean;
  readonly acknowledged: boolean;
  readonly routedToCadence: boolean;
}

export interface BookingProof {
  readonly url: string;
  readonly surface: "outreach_cta" | "landing_form" | "trial_start";
  readonly trackingRef: string;
}

export interface FirstCustomerProof {
  readonly prospectSource: ProspectSourceProof;
  readonly outboundDelivery: OutboundDeliveryProof;
  readonly reply: ReplyProof;
  readonly inboundRoute: InboundRouteProof;
  readonly booking: BookingProof;
}

export interface FirstCustomerProofGap {
  readonly requirement: FirstCustomerRequirement;
  readonly message: string;
}

export interface FirstCustomerProofResult {
  readonly proven: boolean;
  readonly gaps: readonly FirstCustomerProofGap[];
}

const MOCK_EMAIL_DOMAINS = [
  "@example.test",
  ".example.test",
  "@example.com",
  "@example.org",
  "@example.net",
] as const;

function hasMockEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return MOCK_EMAIL_DOMAINS.some((suffix) => normalized.endsWith(suffix));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function nonBlank(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function push(gaps: FirstCustomerProofGap[], requirement: FirstCustomerRequirement, message: string): void {
  gaps.push({ requirement, message });
}

export function verifyFirstCustomerProof(proof: FirstCustomerProof): FirstCustomerProofResult {
  const gaps: FirstCustomerProofGap[] = [];
  const sourceEmails = proof.prospectSource.sampleEmails.map(normalizeEmail);
  const recipient = normalizeEmail(proof.outboundDelivery.recipient);
  const trackingRef = proof.prospectSource.trackingRef.trim();

  if (proof.prospectSource.importedCount < 1) {
    push(gaps, "real_prospect_source", "At least one prospect must be imported from a real source.");
  }
  if (proof.prospectSource.fabricatedCount !== 0) {
    push(gaps, "real_prospect_source", "Fabricated prospects must be zero for first-customer proof.");
  }
  if (proof.prospectSource.sampleEmails.length === 0) {
    push(gaps, "real_prospect_source", "A read-back sample email is required to prove the import.");
  }
  if (proof.prospectSource.sampleEmails.some(hasMockEmail)) {
    push(gaps, "real_prospect_source", "Mock/example email domains cannot prove a real prospect source.");
  }
  if (!nonBlank(trackingRef)) {
    push(gaps, "real_prospect_source", "A durable trackingRef is required to correlate the buyer journey.");
  }

  const delivery = proof.outboundDelivery;
  if (delivery.channel !== "email_postmark") {
    push(gaps, "real_outbound_delivery", "First outbound proof must use the connected Postmark email channel.");
  }
  if (delivery.provider.trim().toLowerCase() !== "postmark") {
    push(gaps, "real_outbound_delivery", "Dry-run or non-Postmark providers do not prove inbox delivery.");
  }
  if ((delivery.approvalRequestId ?? "").trim() === "") {
    push(gaps, "real_outbound_delivery", "A #13 approval id must be tied to the irreversible send.");
  }
  if (hasMockEmail(delivery.recipient)) {
    push(gaps, "real_outbound_delivery", "The delivered recipient must not be a mock/example address.");
  }
  if (!sourceEmails.includes(recipient)) {
    push(gaps, "real_outbound_delivery", "The delivered recipient must match the imported prospect sample.");
  }
  if (delivery.trackingRef.trim() !== trackingRef) {
    push(gaps, "real_outbound_delivery", "Outbound delivery must carry the same trackingRef as the prospect source.");
  }
  if (!isExternalReceipt(delivery.receipt) || delivery.receipt.source !== "production_readback") {
    push(gaps, "real_outbound_delivery", "A verified ESP production_readback receipt with message id is required.");
  }

  if (proof.reply.providerThreadId.trim() === "" || proof.reply.replyMessageId.trim() === "") {
    push(gaps, "reply_ingested_visible", "Reply proof must include provider thread and message ids.");
  }
  if (normalizeEmail(proof.reply.replyFrom) !== recipient) {
    push(gaps, "reply_ingested_visible", "The visible reply must come from the delivered prospect email.");
  }
  if (!proof.reply.visibleInLeadTimeline || !proof.reply.visibleInInbox) {
    push(gaps, "reply_ingested_visible", "The prospect reply must be threaded and visible in both lead and inbox surfaces.");
  }

  if (proof.inboundRoute.rule !== "inbound_lead") {
    push(gaps, "inbound_qualified_routed", "The default inbound_lead rule must qualify the hand-raiser.");
  }
  if (proof.inboundRoute.leadId.trim() === "") {
    push(gaps, "inbound_qualified_routed", "Inbound routing proof must include a durable lead id.");
  }
  if (normalizeEmail(proof.inboundRoute.leadEmail) !== recipient) {
    push(gaps, "inbound_qualified_routed", "The routed lead must belong to the delivered prospect email.");
  }
  if (proof.inboundRoute.trackingRef.trim() !== trackingRef) {
    push(gaps, "inbound_qualified_routed", "Inbound routing proof must preserve the same trackingRef.");
  }
  if (!proof.inboundRoute.autoQualified || !proof.inboundRoute.acknowledged || !proof.inboundRoute.routedToCadence) {
    push(
      gaps,
      "inbound_qualified_routed",
      "Inbound lead must be auto-qualified, acknowledged, and routed to cadence.",
    );
  }

  if (!isHttpUrl(proof.booking.url)) {
    push(gaps, "booking_or_trial_link", "A reachable booking or trial HTTP(S) link is required.");
  }
  if (proof.booking.trackingRef.trim() !== trackingRef || !proof.booking.url.includes(trackingRef)) {
    push(gaps, "booking_or_trial_link", "The booking or trial link must carry the same trackingRef.");
  }

  return { proven: gaps.length === 0, gaps };
}
