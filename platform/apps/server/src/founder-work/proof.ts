import { isExternalReceipt, type ExternalReceipt } from "../action-contract/receipt.js";

/**
 * External paid-work proof gate (#387).
 *
 * #387 is not proven by better self-marketing, a mocked bounty, a generated deliverable, or a manual
 * "someone paid" claim. The close bar is the founder primitive: find externally sourced paid work,
 * deliver verified work for that external customer, send it through the approval gate, and record real
 * payment from a production payment system.
 */

export type ExternalPaidWorkRequirement =
  | "external_opportunity"
  | "verified_deliverable"
  | "approved_delivery"
  | "external_payment";

export type ExternalPaidWorkOpportunitySource =
  | "public_bounty"
  | "client_request"
  | "marketplace_gig"
  | "lead_gen_ask"
  | "ops_job"
  | "self_marketing";

export interface ExternalPaidWorkOpportunityProof {
  readonly source: ExternalPaidWorkOpportunitySource;
  readonly sourceUrl: string;
  readonly customerRef: string;
  readonly valueCents: number;
  readonly currency: string;
  readonly externallySourced: boolean;
  readonly selfMarketing: boolean;
}

export interface ExternalPaidWorkDeliverableProof {
  readonly kind: "landing_page" | "lead_list" | "data_cleanup" | "campaign_asset" | "ops_deliverable";
  readonly deliverableRef: string;
  readonly verificationPassed: boolean;
  readonly verificationReceipt: ExternalReceipt;
}

export interface ExternalPaidWorkDeliveryProof {
  readonly approvalRequestId: string;
  readonly receipt: ExternalReceipt;
}

export interface ExternalPaidWorkPaymentProof {
  readonly provider: "stripe" | "paypal" | "bank" | "marketplace" | "manual_claim";
  readonly providerEventId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly customerRef: string;
  readonly receipt: ExternalReceipt;
}

export interface ExternalPaidWorkProof {
  readonly opportunity: ExternalPaidWorkOpportunityProof;
  readonly deliverable: ExternalPaidWorkDeliverableProof;
  readonly delivery: ExternalPaidWorkDeliveryProof;
  readonly payment: ExternalPaidWorkPaymentProof;
}

export interface ExternalPaidWorkProofGap {
  readonly requirement: ExternalPaidWorkRequirement;
  readonly message: string;
}

export interface ExternalPaidWorkProofResult {
  readonly proven: boolean;
  readonly gaps: readonly ExternalPaidWorkProofGap[];
}

function push(
  gaps: ExternalPaidWorkProofGap[],
  requirement: ExternalPaidWorkRequirement,
  message: string,
): void {
  gaps.push({ requirement, message });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function verifyExternalPaidWorkProof(proof: ExternalPaidWorkProof): ExternalPaidWorkProofResult {
  const gaps: ExternalPaidWorkProofGap[] = [];
  const opportunity = proof.opportunity;

  if (!opportunity.externallySourced || opportunity.selfMarketing || opportunity.source === "self_marketing") {
    push(gaps, "external_opportunity", "The opportunity must be external paid work, not ipop self-marketing.");
  }
  if (!isHttpUrl(opportunity.sourceUrl) || opportunity.customerRef.trim() === "" || opportunity.valueCents <= 0) {
    push(
      gaps,
      "external_opportunity",
      "Opportunity proof must include a real source URL, external customer ref, and positive value.",
    );
  }

  const deliverable = proof.deliverable;
  if (deliverable.deliverableRef.trim() === "" || !deliverable.verificationPassed) {
    push(gaps, "verified_deliverable", "Delivered work must have a durable ref and passed verification.");
  }
  if (!isExternalReceipt(deliverable.verificationReceipt)) {
    push(gaps, "verified_deliverable", "Deliverable verification must be backed by production-grounded proof.");
  }

  if (proof.delivery.approvalRequestId.trim() === "") {
    push(gaps, "approved_delivery", "External customer delivery must be tied to a #13 approval id.");
  }
  if (!isExternalReceipt(proof.delivery.receipt)) {
    push(gaps, "approved_delivery", "Delivery must include a production readback receipt.");
  }

  const payment = proof.payment;
  if (payment.provider === "manual_claim" || payment.providerEventId.trim() === "") {
    push(gaps, "external_payment", "Payment proof must come from a real provider event, not a manual claim.");
  }
  if (payment.amountCents <= 0 || payment.currency.trim().toLowerCase() !== opportunity.currency.trim().toLowerCase()) {
    push(gaps, "external_payment", "Payment must be positive and use the opportunity currency.");
  }
  if (payment.customerRef.trim() === "" || payment.customerRef !== opportunity.customerRef) {
    push(gaps, "external_payment", "Payment must be tied back to the external opportunity customer.");
  }
  if (!isExternalReceipt(payment.receipt) || payment.receipt.source !== "production_readback") {
    push(gaps, "external_payment", "Payment must have a production readback receipt from the payment provider.");
  }

  return { proven: gaps.length === 0, gaps };
}
