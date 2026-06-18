/**
 * The external receipt (issue #337, ADR-0337). The premortem (#200 §2/§3) is absolute: a success claim
 * may only rest on a **production-grounded** receipt — something the system observed by touching reality
 * (a live URL that a real probe reached, or a real read-back from a production system). A self-reported
 * "I deployed it" is fiction. This module is the single, pure predicate the contract uses to decide
 * "is this proof real?" — never assume success.
 *
 * Pure + dependency-free so it runs in the no-DB/no-network unit job.
 */

/**
 * The only two ways a receipt can be production-grounded:
 *   - `live_url`            — a public URL a real HTTP probe reached; `httpStatus` is the status it
 *                             actually returned (a 2xx/3xx — proof the surface is live and reachable).
 *   - `production_readback` — a real value read back from a production system (a Stripe event id, a
 *                             delivery-webhook id, an analytics row, a DB row in prod).
 *
 * Anything else (an agent's claim, an estimate, an assumption) is NOT a receipt and can never mark
 * success. The set is a closed allow-list, not a deny-list — an unknown source is rejected.
 */
export const RECEIPT_SOURCES = ["live_url", "production_readback"] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

/** A production-grounded receipt — the external proof an action actually reached reality (#200 §2). */
export interface ExternalReceipt {
  /** How reality was touched. Only {@link RECEIPT_SOURCES} count — a closed allow-list. */
  source: ReceiptSource;
  /** The external reference observed in production: a live URL, a post id, a message id, an event id. */
  externalRef: string;
  /** ISO timestamp at which reality was observed. Passed in by the caller (the contract never reads a clock). */
  observedAt: string;
  /** For `live_url`: the HTTP status a real probe returned. Required for `live_url`; must be reachable (2xx/3xx). */
  httpStatus?: number;
  /** Optional structured detail (the probe response, the read-back row) for the audit trail. */
  detail?: Record<string, unknown>;
}

function isReceiptSource(value: unknown): value is ReceiptSource {
  return typeof value === "string" && (RECEIPT_SOURCES as readonly string[]).includes(value);
}

/** A reachable HTTP status — a real probe that got through (2xx success or 3xx redirect). */
function isReachableStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

/**
 * The single source of truth for "is this a real, production-grounded receipt?" (#200 §2/§3). Total and
 * pure — accepts `unknown` so a fabricated or malformed receipt (the injection / self-report case) is
 * rejected at runtime, not merely by the type system. A receipt counts ONLY when:
 *   - it is an object with a known {@link ReceiptSource} (an unknown/self-reported source is rejected),
 *   - `externalRef` is a non-blank string (an actual reference, not an empty promise),
 *   - `observedAt` is a non-blank string (reality was observed at some time),
 *   - and, for a `live_url`, the probe returned a reachable status (a 503/500 page is NOT a live surface).
 */
export function isExternalReceipt(value: unknown): value is ExternalReceipt {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (!isReceiptSource(r.source)) return false;
  if (typeof r.externalRef !== "string" || r.externalRef.trim() === "") return false;
  if (typeof r.observedAt !== "string" || r.observedAt.trim() === "") return false;
  if (r.source === "live_url") {
    // A live-URL receipt MUST carry the status a real probe returned, and it must be reachable.
    if (typeof r.httpStatus !== "number" || !isReachableStatus(r.httpStatus)) return false;
  }
  return true;
}
