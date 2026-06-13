/**
 * Disclaimer rails (#196, criterion 5). The autonomous company generates legal text; it must never
 * present that text — to users or to its own owner — as legal advice or the practice of law. These
 * constants are the single source of truth, baked into every generated document footer and asserted by
 * `legal-disclaimer.test.ts` so the rail can never silently regress.
 */

/** Appended to the foot of every generated ToS / privacy policy. */
export const DOCUMENT_DISCLAIMER = [
  "---",
  "",
  "**Notice — not legal advice.** This document was generated programmatically from the facts on file",
  "for this venture. It is provided for operational convenience only, is **not legal advice**, and does",
  "not constitute the provision of legal services or create an attorney–client relationship. Laws vary by",
  "jurisdiction and change over time. Have a licensed attorney review this document before you rely on it.",
].join("\n");

/** The one-line rail an agent must prepend whenever it surfaces legal output in chat / a brief. */
export const AGENT_LEGAL_DISCLAIMER =
  "⚖️ Generated draft — not legal advice. Have a licensed attorney review before relying on it.";

/** The hard-stop notice attached to a regulated-industry high-risk approval (criterion 5). */
export const REGULATED_HARD_STOP_NOTICE =
  "This venture appears to operate in a regulated industry. Autonomous launch is blocked: a human owner " +
  "must review and obtain qualified legal/compliance counsel before proceeding.";
