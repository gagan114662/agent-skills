/**
 * Outbound-email suppression / DNC + consent list (issue #594, premortem #200 §4).
 *
 * #594 asks for an outbound email channel whose suppression list is enforced on *every* send. This
 * module is the one place that answers "are we allowed to email this address?" — and it answers with
 * the most conservative reading the law and deliverability demand:
 *
 *   - **Suppression / DNC ALWAYS wins.** Anyone who bounced, complained, unsubscribed, was manually
 *     blocked, or is on an explicit Do-Not-Contact list is a HARD block. No consent record, campaign,
 *     or agent intention can override it — a suppressed address is never contactable, full stop.
 *   - **Consent is REQUIRED.** Contacting a stranger with no recorded opt-in is exactly the
 *     irreversible blast-radius #200 §4 warns about, so the absence of consent is a block, not a
 *     warning. Consent can also expire (an ageing imported list is not a standing licence to mail).
 *   - **Withdrawing consent opts the address out** — it both revokes consent and adds an `unsubscribe`
 *     suppression entry, so a withdrawal can never be silently "forgotten".
 *
 * The decision logic is pure (a function of a policy snapshot + the injected clock), so it is unit
 * tested entirely offline. {@link InMemoryContactPolicyStore} is a dependency-free, self-contained
 * implementation of the {@link ContactPolicy} read interface — it owns its own state and touches no
 * DB, schema barrel, or app registry. A persistence-backed policy can implement the same interface
 * later without changing a line of the gate.
 */

import { normalizeRecipient } from "../acquisition/compliance.js";

/**
 * Why an address is suppressed. `bounce`/`complaint` come from ESP webhooks; `unsubscribe` from a
 * recipient action (incl. consent withdrawal); `manual`/`dnc` are explicit owner blocks. `dnc` is the
 * strongest signal — an address the owner has declared must never be contacted again.
 */
export const SUPPRESSION_REASONS = ["bounce", "complaint", "unsubscribe", "manual", "dnc"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** How consent to email an address was obtained. Used for audit/cite; all bases require a real opt-in. */
export const CONSENT_BASES = ["opt_in", "double_opt_in", "existing_customer", "imported"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

/** A recorded consent grant for an address (epoch-ms `at` so expiry is a pure clock comparison). */
export interface ConsentRecord {
  basis: ConsentBasis;
  /** When consent was granted (epoch ms). */
  at: number;
}

/** A recorded suppression entry for an address. */
export interface SuppressionRecord {
  reason: SuppressionReason;
  /** When the address was suppressed (epoch ms). */
  at: number;
}

/**
 * The read interface the contact gate consults. Deliberately tiny so any backing store (in-memory,
 * Postgres, Redis) can satisfy it. `null` means "no record", never "allowed".
 */
export interface ContactPolicy {
  /** The suppression entry for an address, or null when not suppressed. */
  suppressionOf(email: string): SuppressionRecord | null;
  /** The active consent record for an address, or null when none was ever granted / it was withdrawn. */
  consentOf(email: string): ConsentRecord | null;
}

export interface EvaluateContactOptions {
  /** Current time (epoch ms), injected so the decision is deterministic. */
  now: number;
  /** If set, consent older than this many ms is treated as expired (not contactable). */
  consentTtlMs?: number;
}

export interface ContactDecision {
  /** Cleared to contact IFF not suppressed AND has active, unexpired consent. */
  contactable: boolean;
  /** The normalized address the decision was made for. */
  email: string;
  /** True when an explicit suppression / DNC entry exists (always blocks). */
  suppressed: boolean;
  /** True when an active, unexpired consent record exists. */
  hasConsent: boolean;
  /** Human-readable reasons the address is blocked (empty when contactable). */
  reasons: string[];
}

/**
 * The always-enforced contact gate. An address is contactable IFF it is NOT suppressed AND has an
 * active, unexpired consent record. Suppression is checked first and is absolute — a suppressed
 * address is never contactable regardless of consent. Total + pure (a function of the policy + clock).
 */
export function evaluateContact(
  policy: ContactPolicy,
  rawEmail: string,
  opts: EvaluateContactOptions,
): ContactDecision {
  const email = normalizeRecipient(rawEmail);
  const reasons: string[] = [];

  const suppression = email ? policy.suppressionOf(email) : null;
  const suppressed = suppression !== null;
  if (suppressed) {
    reasons.push(`address is suppressed (${suppression!.reason}) — never contact`);
  }

  const consent = email ? policy.consentOf(email) : null;
  let hasConsent = consent !== null;
  if (!consent) {
    reasons.push("no recorded consent — contacting requires an opt-in");
  } else if (opts.consentTtlMs !== undefined && opts.now - consent.at > opts.consentTtlMs) {
    hasConsent = false;
    reasons.push("consent has expired — re-confirmation required");
  }

  if (!email) reasons.push("empty/invalid recipient address");

  const contactable = Boolean(email) && !suppressed && hasConsent;
  return { contactable, email, suppressed, hasConsent, reasons: contactable ? [] : reasons };
}

export interface ContactableBatch {
  /** Normalized, de-duplicated addresses cleared to contact. */
  contactable: string[];
  /** Addresses dropped, each with the reasons it was blocked. */
  blocked: { email: string; reasons: string[] }[];
}

/**
 * Split a batch of recipients into the contactable set and the blocked set, normalizing and
 * de-duplicating. Suppressed / non-consented / expired addresses are ALWAYS in `blocked`, never in
 * `contactable` — this is the batch form of the always-enforced gate. Total + pure.
 */
export function filterContactable(
  policy: ContactPolicy,
  recipients: string[],
  opts: EvaluateContactOptions,
): ContactableBatch {
  const contactable: string[] = [];
  const blocked: { email: string; reasons: string[] }[] = [];
  const seen = new Set<string>();
  for (const raw of recipients) {
    const email = normalizeRecipient(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const d = evaluateContact(policy, email, opts);
    if (d.contactable) contactable.push(email);
    else blocked.push({ email, reasons: d.reasons });
  }
  return { contactable, blocked };
}

/**
 * A dependency-free, self-contained {@link ContactPolicy} backed by in-memory maps. Owns its own
 * state — no DB, migration, schema barrel, or app registry. Suitable for tests and for an in-process
 * policy; swap in a persistent implementation of {@link ContactPolicy} without touching the gate.
 */
export class InMemoryContactPolicyStore implements ContactPolicy {
  private readonly suppressions = new Map<string, SuppressionRecord>();
  private readonly consents = new Map<string, ConsentRecord>();

  suppressionOf(email: string): SuppressionRecord | null {
    return this.suppressions.get(normalizeRecipient(email)) ?? null;
  }

  consentOf(email: string): ConsentRecord | null {
    return this.consents.get(normalizeRecipient(email)) ?? null;
  }

  /** Record an active consent grant for an address (overwrites any prior grant). */
  recordConsent(email: string, record: ConsentRecord): void {
    this.consents.set(normalizeRecipient(email), record);
  }

  /**
   * Add/refresh a suppression entry. A stronger reason is never downgraded by a weaker later one
   * (e.g. a `dnc` entry is not overwritten by a `bounce`), so suppression only ever tightens.
   */
  suppress(email: string, record: SuppressionRecord): void {
    const key = normalizeRecipient(email);
    const existing = this.suppressions.get(key);
    if (existing && rank(existing.reason) >= rank(record.reason)) return;
    this.suppressions.set(key, record);
  }

  /** Withdraw consent: revoke the grant AND suppress as an unsubscribe (an opt-out is permanent). */
  withdrawConsent(email: string, opts: { at: number }): void {
    const key = normalizeRecipient(email);
    this.consents.delete(key);
    this.suppress(key, { reason: "unsubscribe", at: opts.at });
  }
}

/** Severity ordering so {@link InMemoryContactPolicyStore.suppress} only ever tightens, never relaxes. */
function rank(reason: SuppressionReason): number {
  return SUPPRESSION_REASONS.indexOf(reason);
}
