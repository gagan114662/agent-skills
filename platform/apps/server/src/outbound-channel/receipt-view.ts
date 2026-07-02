/**
 * The dashboard read-back of a persisted outbound send receipt (issue #395 §3, premortem #200 §3). Pure +
 * dependency-free — runs in the no-DB/no-network unit job.
 *
 * `verifyAndRecordSend` (service.ts) persists a receipt for every approved send that touched reality, but until
 * now nothing READ that ledger back to the owner: `listSendReceipts` had no caller, so an approved send's proof
 * was invisible in the dashboard. This module maps a stored `SendReceiptRow` into the owner-facing view that the
 * Connections surface renders — dropping the internal `workspaceId` and the free-form `detail` blob (an
 * ESP-sourced value we never echo raw, #200 §6) and exposing only the fields the owner needs to see that a real
 * (sandbox) send landed: which channel, to whom, the production message id / live URL, and whether it verified.
 */

import type { OutboundChannel, OutboundReceiptSource } from "./constants.js";

/** A stored send receipt as the owner sees it — the safe subset of the ledger row (no workspaceId, no detail). */
export interface OutboundSendReceiptView {
  id: string;
  channel: OutboundChannel;
  /** The recipient the approved send went to. */
  recipient: string;
  /** `production_readback` (an ESP message id) or `live_url` (a probed URL) — the #200 §3 proof kind. */
  source: OutboundReceiptSource;
  /** The production-grounded reference: a Postmark/Resend MessageID, or the probed URL. */
  externalRef: string;
  /** The HTTP status for a `live_url` receipt; null for an ESP read-back. */
  httpStatus: number | null;
  /** True only when the receipt passed the #200 §3 external-receipt predicate (a real send actually landed). */
  verified: boolean;
  /** The #13 approval that authorized this send (null only for legacy/unattributed rows). */
  approvalRequestId: string | null;
  /** When reality was observed (the read-back), epoch ms. */
  observedAtMs: number;
  /** When the receipt row was written, epoch ms. */
  createdAtMs: number;
}

/** The stored-row shape this mapper reads. A structural subset of the repository's `SendReceiptRow`. */
export interface StoredSendReceipt {
  id: string;
  channel: OutboundChannel;
  recipient: string;
  source: OutboundReceiptSource;
  externalRef: string;
  httpStatus: number | null;
  verified: boolean;
  approvalRequestId: string | null;
  observedAtMs: number;
  createdAtMs: number;
}

/**
 * Map a stored send receipt to the owner-facing dashboard view. Total + pure: it copies only the safe display
 * fields, so the internal `workspaceId` and the free-form `detail` blob are structurally excluded — they can
 * never leak into the response even if the row carries them.
 */
export function toOutboundReceiptView(row: StoredSendReceipt): OutboundSendReceiptView {
  return {
    id: row.id,
    channel: row.channel,
    recipient: row.recipient,
    source: row.source,
    externalRef: row.externalRef,
    httpStatus: row.httpStatus,
    verified: row.verified,
    approvalRequestId: row.approvalRequestId,
    observedAtMs: row.observedAtMs,
    createdAtMs: row.createdAtMs,
  };
}
