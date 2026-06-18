/**
 * Email deliverability verification — SPF/DKIM/DMARC alignment (issue #268, ADR-0268, premortem #200 §3).
 *
 * "Good deliverability with zero DNS work" is the headline acceptance of #268, and the premortem's third
 * failure mode — *verification must touch reality* — is the standing rule it must answer to. So this module
 * NEVER assumes a sender is authenticated; it grades two tiers of evidence and refuses to claim
 * deliverability on anything weaker than a production receipt:
 *
 *   1. **Config side** ({@link assessSenderAuth}) — are the SPF/DKIM/DMARC records actually published and
 *      verified at the registrar (the receipts the #264 `DnsManager` writes)? A missing record is `unknown`,
 *      never `pass`.
 *   2. **Reality side** ({@link parseAuthenticationResults}) — what does the `Authentication-Results` header
 *      of a *delivered* message say? This is the only tier that proves a real mailbox provider accepted the
 *      authentication; it is the production-grounded receipt #200 §3 demands.
 *
 * {@link confirmDeliverability} combines them: a sender is deliverable ONLY when the config is aligned AND a
 * delivered-message header confirms all three pass. Config alignment alone is explicitly NOT enough — that
 * is the whole point of the premortem rule. All pure: no IO, no clock, unit-tested offline.
 */

/** A single authentication mechanism's verdict. `unknown` means "no evidence" — it is never treated as a pass. */
export type AuthMechanismStatus = "pass" | "fail" | "unknown";

/** The published-DNS facts the config-side assessment grades (from the #264 DnsManager verify receipts). */
export interface SenderAuthInput {
  /** SPF: is the apex SPF TXT published, and does it `include:` the ESP's sending host? */
  spf: { published: boolean; includesEsp: boolean } | undefined;
  /** DKIM: is the `<selector>._domainkey` record published, and has the ESP verified the key? */
  dkim: { published: boolean; verified: boolean } | undefined;
  /** DMARC: is the `_dmarc` TXT published, and at what policy? */
  dmarc: { published: boolean; policy: "none" | "quarantine" | "reject" } | undefined;
}

export interface SenderAuthAssessment {
  spf: AuthMechanismStatus;
  dkim: AuthMechanismStatus;
  dmarc: AuthMechanismStatus;
  /** Aligned ⇒ all three mechanisms pass. The config-side bar for a sender not to be junked. */
  aligned: boolean;
  /** Human-readable reasons each non-passing mechanism is not yet a pass (empty when aligned). */
  reasons: string[];
}

/**
 * Grade the published SPF/DKIM/DMARC config. A mechanism with no input is `unknown` (we have no evidence,
 * so we must not claim it passes); a published-but-incomplete mechanism (SPF without the ESP include, DKIM
 * not yet verified by the ESP) is a `fail`. `aligned` requires all three to pass. Total + pure.
 */
export function assessSenderAuth(input: SenderAuthInput): SenderAuthAssessment {
  const reasons: string[] = [];

  let spf: AuthMechanismStatus;
  if (!input.spf || !input.spf.published) {
    spf = "unknown";
    reasons.push("SPF record not published (deliverability unverified)");
  } else if (!input.spf.includesEsp) {
    spf = "fail";
    reasons.push("SPF record published but does not include the ESP sending host");
  } else {
    spf = "pass";
  }

  let dkim: AuthMechanismStatus;
  if (!input.dkim || !input.dkim.published) {
    dkim = "unknown";
    reasons.push("DKIM record not published (deliverability unverified)");
  } else if (!input.dkim.verified) {
    dkim = "fail";
    reasons.push("DKIM record published but not yet verified by the ESP");
  } else {
    dkim = "pass";
  }

  let dmarc: AuthMechanismStatus;
  if (!input.dmarc || !input.dmarc.published) {
    dmarc = "unknown";
    reasons.push("DMARC record not published (deliverability unverified)");
  } else {
    dmarc = "pass";
  }

  const aligned = spf === "pass" && dkim === "pass" && dmarc === "pass";
  return { spf, dkim, dmarc, aligned, reasons };
}

/** The three mechanism verdicts read off a delivered message's `Authentication-Results` header. */
export interface AuthResults {
  spf: AuthMechanismStatus;
  dkim: AuthMechanismStatus;
  dmarc: AuthMechanismStatus;
}

/** Extract the verdict for one mechanism from an `Authentication-Results` header value. */
function mechanismFromHeader(header: string, mechanism: "spf" | "dkim" | "dmarc"): AuthMechanismStatus {
  // Match e.g. `spf=pass`, `DKIM = FAIL`, allowing surrounding whitespace; case-insensitive.
  const m = new RegExp(`\\b${mechanism}\\s*=\\s*(pass|fail|none|neutral|softfail|temperror|permerror)\\b`, "i").exec(
    header,
  );
  if (!m) return "unknown";
  const verdict = m[1]!.toLowerCase();
  return verdict === "pass" ? "pass" : "fail";
}

/**
 * Parse a delivered message's `Authentication-Results` header into per-mechanism verdicts. A mechanism
 * absent from the header is `unknown` (never assumed to pass). Any non-`pass` verdict (fail/none/softfail/
 * temperror/...) is a `fail` for deliverability purposes. A null/empty header yields all-unknown. Total + pure.
 */
export function parseAuthenticationResults(header: string | null | undefined): AuthResults {
  if (typeof header !== "string" || header.trim().length === 0) {
    return { spf: "unknown", dkim: "unknown", dmarc: "unknown" };
  }
  return {
    spf: mechanismFromHeader(header, "spf"),
    dkim: mechanismFromHeader(header, "dkim"),
    dmarc: mechanismFromHeader(header, "dmarc"),
  };
}

export interface DeliverabilityConfirmation {
  /** True ONLY when config is aligned AND a delivered-message header confirms all three pass (#200 §3). */
  deliverable: boolean;
  config: SenderAuthAssessment;
  /** The parsed delivered-message header, or null when no production receipt exists yet. */
  headers: AuthResults | null;
  reasons: string[];
}

/**
 * The production-grounded deliverability gate. Combines the config-side assessment with the delivered-message
 * `Authentication-Results` receipt: deliverable IFF the config is aligned AND a header receipt exists whose
 * spf/dkim/dmarc all pass. Config alignment alone is NOT sufficient — without a real delivered-message header
 * the verdict is `false` with a reason, because the premortem (#200 §3) forbids assuming success from a
 * worker-side check that hasn't touched reality. Total + pure.
 */
export function confirmDeliverability(input: {
  auth: SenderAuthInput;
  authResultsHeader?: string | null;
}): DeliverabilityConfirmation {
  const config = assessSenderAuth(input.auth);
  const reasons: string[] = [...config.reasons];

  const hasHeader = typeof input.authResultsHeader === "string" && input.authResultsHeader.trim().length > 0;
  const headers = hasHeader ? parseAuthenticationResults(input.authResultsHeader) : null;

  if (!headers) {
    reasons.push("no delivered-message Authentication-Results receipt yet (deliverability unverified, #200 §3)");
    return { deliverable: false, config, headers: null, reasons };
  }

  for (const mech of ["spf", "dkim", "dmarc"] as const) {
    if (headers[mech] !== "pass") {
      reasons.push(`delivered message ${mech.toUpperCase()} did not pass (got "${headers[mech]}")`);
    }
  }

  const headerPasses = headers.spf === "pass" && headers.dkim === "pass" && headers.dmarc === "pass";
  const deliverable = config.aligned && headerPasses;
  return { deliverable, config, headers, reasons: deliverable ? [] : reasons };
}
