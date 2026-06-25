/**
 * Pure ToS, privacy-policy, and DPA generation (#196, #867). Given a venture's `VentureLegalFacts`, compose
 * deterministic markdown documents — no IO, no model spend, no clock. The output is content-addressed: the
 * `version` is a short hash of the rendered body, and `sourceFactsHash` fingerprints the facts the doc was
 * generated from, so a *material change* (facts-hash drift) is detectable and triggers a regenerate +
 * owner-review (the service compares `sourceFactsHash`). Every document ends with the non-counsel
 * disclaimer rail (`DOCUMENT_DISCLAIMER`).
 *
 * The text is intentionally a clear, plain-language template — it is generated convenience, never a
 * substitute for counsel (criterion 5). Determinism (same facts ⇒ byte-identical body ⇒ same version) is
 * what makes versioning + change-detection trustworthy, so this module takes no `Date`.
 */
import { createHash } from "node:crypto";
import type { ComposedDocument, LegalDocumentKind, VentureLegalFacts } from "./types.js";
import { DOCUMENT_DISCLAIMER } from "./disclaimer.js";

/** Bump when the *template* changes so existing published docs are seen as materially stale. */
export const LEGAL_TEMPLATE_VERSION = "v1";

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Normalize facts to a stable string so the hash is order-independent and whitespace-insensitive. */
export function fingerprintFacts(facts: VentureLegalFacts): string {
  const norm = {
    t: LEGAL_TEMPLATE_VERSION,
    j: facts.jurisdiction.trim().toLowerCase(),
    d: [...facts.dataCollected].map((s) => s.trim().toLowerCase()).filter(Boolean).sort(),
    p: [...facts.paymentFlows].map((s) => s.trim().toLowerCase()).filter(Boolean).sort(),
    i: (facts.industry ?? "").trim().toLowerCase(),
  };
  return shortHash(JSON.stringify(norm));
}

const DATA_LABELS: Record<string, string> = {
  email: "email address",
  name: "name",
  payment: "payment and billing information",
  analytics: "usage and analytics data",
  ip: "IP address and device information",
  location: "approximate location",
  cookies: "cookies and similar technologies",
};

function describeData(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(DATA_LABELS[t] ?? t.replace(/_/g, " "));
  }
  return out.length ? out : ["the information you provide to us"];
}

function describePayments(tokens: string[]): string | null {
  const norm = tokens.map((t) => t.trim().toLowerCase()).filter((t) => t && t !== "none");
  if (norm.length === 0) return null;
  const hasStripe = norm.some((t) => t.includes("stripe"));
  const recurring = norm.some((t) => t.includes("subscription") || t.includes("recurring"));
  const processor = hasStripe ? "our third-party payment processor (Stripe)" : "our third-party payment processor";
  return recurring
    ? `Payments are processed by ${processor}. Paid plans renew automatically until cancelled; you can cancel at any time.`
    : `Payments are processed by ${processor}. We do not store full card numbers on our servers.`;
}

function compose(kind: LegalDocumentKind, facts: VentureLegalFacts): string {
  const jurisdiction = facts.jurisdiction.trim() || "the United States";
  const dataList = describeData(facts.dataCollected);
  const payments = describePayments(facts.paymentFlows);
  const dataBullets = dataList.map((d) => `- ${d.charAt(0).toUpperCase()}${d.slice(1)}`).join("\n");

  if (kind === "tos") {
    const lines = [
      "# Terms of Service",
      "",
      "## 1. Acceptance of terms",
      "By accessing or using this service, you agree to be bound by these Terms of Service. If you do not",
      "agree, do not use the service.",
      "",
      "## 2. The service",
      "We provide the service on an “as is” and “as available” basis. We may modify or discontinue features",
      "at any time.",
      "",
      "## 3. Your account and conduct",
      "You are responsible for activity under your account and for keeping your credentials secure. You agree",
      "not to misuse the service or use it for any unlawful purpose.",
      "",
      payments ? "## 4. Payment" : "## 4. Fees",
      payments ?? "The service may offer paid features; any applicable fees will be disclosed before purchase.",
      "",
      "## 5. Intellectual property",
      "We retain all rights in the service. You retain ownership of content you submit and grant us the",
      "limited license needed to operate the service.",
      "",
      "## 6. Limitation of liability",
      "To the maximum extent permitted by law, we are not liable for indirect, incidental, or consequential",
      "damages arising from your use of the service.",
      "",
      "## 7. Termination",
      "We may suspend or terminate access for violation of these terms. You may stop using the service at any",
      "time.",
      "",
      "## 8. Governing law",
      `These terms are governed by the laws applicable in ${jurisdiction}, without regard to conflict-of-law`,
      "rules.",
      "",
      "## 9. Changes",
      "We may update these terms; material changes will be posted with an updated effective date.",
      "",
      DOCUMENT_DISCLAIMER,
    ];
    return lines.join("\n");
  }

  if (kind === "privacy") {
    const lines = [
    "# Privacy Policy",
    "",
    "## 1. Information we collect",
    "We collect the following categories of information:",
    "",
    dataBullets,
    "",
    "## 2. How we use information",
    "We use the information we collect to provide, maintain, secure, and improve the service, to communicate",
    "with you, and to comply with our legal obligations.",
    "",
    "## 3. Sharing",
    "We do not sell your personal information. We share it only with service providers that help us operate",
    payments
      ? "the service (including our payment processor), and where required by law."
      : "the service, and where required by law.",
    "",
    "## 4. Your rights",
    "You may request a copy of your personal data or ask us to delete it. We honor verified export and",
    "deletion requests; contact us to exercise these rights.",
    "",
    "## 5. Marketing communications",
    "We send commercial email only with a lawful basis (your consent or an existing relationship). Every",
    "marketing message includes a working unsubscribe link and our postal address, and we honor opt-outs",
    "promptly.",
    "",
    "## 6. Data retention and security",
    "We retain personal data only as long as needed for the purposes above and apply reasonable safeguards",
    "to protect it.",
    "",
    "## 7. Governing law",
    `This policy is interpreted under the laws applicable in ${jurisdiction}.`,
    "",
    "## 8. Changes",
    "We may update this policy; material changes will be posted with an updated effective date.",
    "",
    DOCUMENT_DISCLAIMER,
    ];
    return lines.join("\n");
  }

  // dpa
  const lines = [
    "# Data Processing Agreement",
    "",
    "## 1. Roles and scope",
    "This Data Processing Agreement applies when we process personal data on behalf of a customer to provide",
    "the service. The customer is the controller or business, and we act as processor or service provider.",
    "",
    "## 2. Categories of personal data",
    "The service may process the following categories of personal data based on the customer's configuration:",
    "",
    dataBullets,
    "",
    "## 3. Processing instructions",
    "We process personal data only to provide, secure, support, and improve the service, to follow documented",
    "customer instructions, and to comply with applicable law.",
    "",
    "## 4. Subprocessors",
    "We use subprocessors such as hosting, payment, analytics, email, and model providers where needed to run",
    "the service. We remain responsible for subprocessors we engage for the service.",
    "",
    "## 5. Security",
    "We apply workspace isolation, scoped credentials, approval gates, audit logs, and reasonable technical",
    "and organizational safeguards appropriate to the service.",
    "",
    "## 6. Data-subject requests",
    "We will reasonably assist the customer with verified access, export, deletion, objection, or restriction",
    "requests for personal data processed through the service.",
    "",
    "## 7. Return and deletion",
    "On termination or verified request, we will delete or return personal data unless retention is required",
    "for legal, security, billing, or audit obligations.",
    "",
    "## 8. International transfers",
    `This DPA is interpreted under the laws applicable in ${jurisdiction}. Where transfer mechanisms are`,
    "required, the parties will use an appropriate lawful transfer mechanism.",
    "",
    "## 9. Contact",
    "Questions, countersignature requests, and data-subject-rights requests can be sent to support@ipop.ai.",
    "",
    DOCUMENT_DISCLAIMER,
  ];
  return lines.join("\n");
}

/** Compose one content-addressed legal document from the venture facts. */
export function composeDocument(kind: LegalDocumentKind, facts: VentureLegalFacts): ComposedDocument {
  const body = compose(kind, facts);
  const contentHash = shortHash(body);
  return {
    kind,
    body,
    version: contentHash,
    contentHash,
    sourceFactsHash: fingerprintFacts(facts),
  };
}

/** Compose the full pack (ToS + privacy + DPA) for a venture's facts. */
export function composePack(facts: VentureLegalFacts): ComposedDocument[] {
  return [composeDocument("tos", facts), composeDocument("privacy", facts), composeDocument("dpa", facts)];
}

/** A material change = the facts that generated a published doc no longer fingerprint the same. */
export function isMaterialChange(publishedSourceFactsHash: string, currentFacts: VentureLegalFacts): boolean {
  return publishedSourceFactsHash !== fingerprintFacts(currentFacts);
}
