/**
 * Legal & Compliance Pack per venture (#196, ADR-0196) — shared types.
 *
 * The pack makes compliance a *generated, versioned artifact* rather than agent goodwill:
 *  - per-venture ToS + privacy generated from `VentureLegalFacts` (jurisdiction / data collected /
 *    payment flows), versioned by content hash, published through the #13 gate (owner review);
 *  - CAN-SPAM / CASL / GDPR enforced at the send chokepoint via a pure `decideCompliance` (suppression
 *    list, unsubscribe + postal footer, consent records) — see `compliance.ts` + `enforcer.ts`;
 *  - a name/trademark + domain-collision pre-check (`precheck.ts`) the (unbuilt #187) venture factory
 *    calls, its result attached to a pending naming decision;
 *  - per-venture data export + deletion, audited end-to-end (`data_rights_requests`);
 *  - a disclaimer rail so agents never present legal output as counsel, and a regulated-industry
 *    high-risk flag that hard-stops to the owner (`regulated.ts`).
 *
 * Every type here is plain data — no IO. The service (`service.ts`) injects persistence/gate seams.
 */

/** A document the pack generates and versions. */
export type LegalDocumentKind = "tos" | "privacy";
export const LEGAL_DOCUMENT_KINDS: readonly LegalDocumentKind[] = ["tos", "privacy"];

export type LegalDocumentStatus = "draft" | "published";

/**
 * The per-venture facts a ToS/privacy policy is generated from. Kept in its own table (NOT widened onto
 * `venture_ideas`) so the legal pack is additive. `jurisdiction` is a free-form region tag (e.g. `US-CA`,
 * `EU`, `CA`); `dataCollected` / `paymentFlows` are normalized lowercase tokens the generator renders.
 */
export interface VentureLegalFacts {
  ventureIdeaId: string;
  /** Governing-law region tag (e.g. `US-CA`, `EU`, `CA`, `UK`). */
  jurisdiction: string;
  /** What personal data the product collects (e.g. `email`, `name`, `payment`, `analytics`, `ip`). */
  dataCollected: string[];
  /** Payment mechanisms in play (e.g. `stripe_subscription`, `one_time`, `none`). */
  paymentFlows: string[];
  /** Free-form industry label (e.g. `health`, `fintech`, `saas`). Null when unspecified. */
  industry: string | null;
}

/** A generated, versioned legal document. `version` is the short content hash; `sourceFactsHash`
 * fingerprints the facts the doc was generated from so a *material change* (facts hash drift) triggers
 * a regenerate + owner review. */
export interface LegalDocument {
  id: string;
  workspaceId: string;
  ventureIdeaId: string;
  kind: LegalDocumentKind;
  version: string;
  contentHash: string;
  sourceFactsHash: string;
  body: string;
  status: LegalDocumentStatus;
  /** The #13 approval that gates publishing this draft (null until submitted). */
  approvalRequestId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}

/** A composed (not-yet-persisted) document — the pure output of `generate.ts`. */
export interface ComposedDocument {
  kind: LegalDocumentKind;
  body: string;
  version: string;
  contentHash: string;
  sourceFactsHash: string;
}

// ───────────────────────────── Send-layer compliance (criterion 2) ─────────────────────────────

/** The legal basis recorded for sending commercial mail to a contact (CASL/GDPR). */
export type ConsentBasis = "opt_in" | "contract" | "legitimate_interest";
export const CONSENT_BASES: readonly ConsentBasis[] = ["opt_in", "contract", "legitimate_interest"];

/** The CAN-SPAM footer assertion a marketing email must carry (recorded-only sends carry no body, so the
 * compliant footer is declared structurally in the action payload and enforced at the chokepoint). */
export interface ComplianceFooter {
  /** A working unsubscribe mechanism is present. */
  unsubscribe: boolean;
  /** A valid physical postal address is present (CAN-SPAM §5). */
  physicalAddress?: string;
}

/** The compliance envelope an outbound send may carry on its action payload. */
export interface ComplianceEnvelope {
  footer?: ComplianceFooter;
  consentBasis?: ConsentBasis;
}

/** Input to the pure send-compliance decision. `suppressed`/`hasConsent` are resolved from the repos by
 * the enforcer; the rest comes off the action payload. */
export interface ComplianceInput {
  /** The marketing send kind (`email.send` | `social.post` | `ad.spend` | `content.publish`). */
  kind: string;
  /** The recipient/contact/handle the send targets (null when targetless). */
  target: string | null;
  envelope?: ComplianceEnvelope;
  /** The target is on the workspace suppression list. */
  suppressed: boolean;
  /** A consent record exists for the target. */
  hasConsent: boolean;
}

/** The verdict of `decideCompliance`. `allow=false` blocks the send; `reason` is the audit line. */
export interface ComplianceDecision {
  allow: boolean;
  reason: string | null;
  /** The rule keys evaluated (audit trail), e.g. `suppression`, `can_spam_footer`, `consent`. */
  rules: string[];
}

export interface EmailSuppression {
  contact: string;
  reason: string;
  source: SuppressionSource;
  createdAt: Date;
}

export type SuppressionSource = "unsubscribe" | "bounce" | "deletion_request" | "manual";
export const SUPPRESSION_SOURCES: readonly SuppressionSource[] = [
  "unsubscribe",
  "bounce",
  "deletion_request",
  "manual",
];

export interface ConsentRecord {
  contact: string;
  basis: ConsentBasis;
  ventureIdeaId: string | null;
  sourceRef: string | null;
  createdAt: Date;
}

// ───────────────────────────── Naming pre-check (criterion 3) ─────────────────────────────

export type TrademarkRisk = "low" | "medium" | "high";

export interface DomainCollision {
  domain: string;
  available: boolean;
}

/** The result a `NamingPrecheck` returns — attached to the venture's naming decision. */
export interface NamingPrecheckResult {
  name: string;
  trademarkRisk: TrademarkRisk;
  trademarkNotes: string[];
  domainCollisions: DomainCollision[];
  /** No high trademark risk AND at least one candidate domain is available. */
  clearToProceed: boolean;
}

/**
 * The clean interface the venture factory's naming step (#187, NOT yet built) calls before anything is
 * purchased. The production impl is a deterministic stand-in (no real WHOIS/USPTO/model spend), mirroring
 * how `venture/default.ts` ships deterministic gatherers; swapping a real provider in later is a one-line
 * change in `default.ts`.
 */
export interface NamingPrecheck {
  check(input: { name: string; domains: string[] }): Promise<NamingPrecheckResult>;
}

// ───────────────────────────── Regulated-industry hard-stop (criterion 5) ─────────────────────────────

export type RiskDisposition = "proceed" | "owner_review" | "hard_stop";

/** The regulated-industry verdict. `hard_stop` ⇒ a high-risk regulated venture that must reach the owner
 * and can never auto-approve. */
export interface RegulatedAssessment {
  regulated: boolean;
  /** The matched regulated category (e.g. `health`, `finance`, `children`), or null. */
  category: string | null;
  reasons: string[];
  disposition: RiskDisposition;
}

// ───────────────────────────── Data rights (criterion 4) ─────────────────────────────

export type DataRightsType = "export" | "deletion";
export const DATA_RIGHTS_TYPES: readonly DataRightsType[] = ["export", "deletion"];

export type DataRightsStatus = "received" | "completed";

export interface DataRightsRequest {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  subjectContact: string;
  type: DataRightsType;
  status: DataRightsStatus;
  requestedByMemberId: string | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  completedAt: Date | null;
}
