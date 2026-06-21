/**
 * The readback-receipt builders for an outbound send (issue #395 §3, premortem #200 §3). Pure +
 * dependency-free — runs in the no-DB/no-network unit job.
 *
 * #200 §3 is absolute: verification must TOUCH REALITY. After a send, we do NOT trust the agent's "done";
 * we confirm the send actually reached reality and record a production-grounded receipt. This module shapes
 * the two valid receipt kinds and re-uses the single source-of-truth predicate (`isExternalReceipt`) so a
 * fabricated or self-reported "receipt" can never clear the bar. It owns no clock — `observedAt` is passed
 * in by the caller.
 */

import { isExternalReceipt, type ExternalReceipt } from "../action-contract/receipt.js";

export { isExternalReceipt };
export type { ExternalReceipt };

/**
 * Build a `production_readback` receipt from an ESP message id (e.g. a Postmark `MessageID`). This is the
 * "a real send reached a real inbox" proof — a real value read back from the delivery provider. Returns
 * `null` if the message id or observed timestamp is blank (nothing to prove).
 */
export function buildEspReadbackReceipt(input: {
  messageId: string;
  observedAt: string;
  detail?: Record<string, unknown>;
}): ExternalReceipt | null {
  const externalRef = (input.messageId ?? "").trim();
  const observedAt = (input.observedAt ?? "").trim();
  if (externalRef === "" || observedAt === "") return null;
  const receipt: ExternalReceipt = { source: "production_readback", externalRef, observedAt };
  if (input.detail) receipt.detail = input.detail;
  // Defensive: only return something the predicate accepts (it never should fail here, but never assume).
  return isExternalReceipt(receipt) ? receipt : null;
}

/**
 * Build a `live_url` receipt from a real HTTP probe (e.g. a hosted unsubscribe/confirmation page). The
 * status MUST be reachable (2xx/3xx) for `isExternalReceipt` to accept it. Returns `null` if blank or
 * unreachable.
 */
export function buildLiveUrlReceipt(input: {
  url: string;
  httpStatus: number;
  observedAt: string;
  detail?: Record<string, unknown>;
}): ExternalReceipt | null {
  const externalRef = (input.url ?? "").trim();
  const observedAt = (input.observedAt ?? "").trim();
  if (externalRef === "" || observedAt === "") return null;
  const receipt: ExternalReceipt = {
    source: "live_url",
    externalRef,
    observedAt,
    httpStatus: input.httpStatus,
  };
  if (input.detail) receipt.detail = input.detail;
  return isExternalReceipt(receipt) ? receipt : null;
}
