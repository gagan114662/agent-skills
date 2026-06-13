/**
 * Pure send-layer compliance decision (#196, criterion 2). CAN-SPAM, CASL, and GDPR are enforced **in
 * code at the chokepoint**, not by agent goodwill: given the send kind, target, the compliance envelope
 * on the action payload, and the resolved suppression/consent state, decide whether the send is allowed.
 * `enforcer.ts` resolves the IO (suppression/consent lookups, recording the audit row); this module is the
 * rule. Keeping it pure makes every rule unit-testable without a DB.
 *
 * Rules (in precedence order), for the per-recipient marketing kinds (`email.send`, `social.post`):
 *  1. **Suppression** — a target on the suppression list is hard-blocked (honors prior unsubscribe /
 *     deletion / bounce). Highest precedence; overrides any consent.
 *  2. **CAN-SPAM footer** (`email.send` only) — a commercial email must declare a working unsubscribe
 *     mechanism AND a physical postal address.
 *  3. **CASL / GDPR consent** (`email.send`, when `requireConsent`) — a lawful basis must exist: an
 *     explicit consent record for the target, or a declared `contract` / `legitimate_interest` basis.
 *
 * `ad.spend` and `content.publish` carry no per-recipient PII obligation here (publishing is gated by #13
 * separately), so they are allowed by this function.
 */
import type { ComplianceDecision, ComplianceInput } from "./types.js";

/** The send kinds this function governs per-recipient. Other kinds pass through. */
const PER_RECIPIENT_KINDS = new Set(["email.send", "social.post"]);

export interface ComplianceOptions {
  /** Require a recorded/declared consent basis for a commercial email (CASL/GDPR). */
  requireConsent: boolean;
}

export function decideCompliance(input: ComplianceInput, opts: ComplianceOptions): ComplianceDecision {
  const rules: string[] = [];

  // Non per-recipient kinds (ad.spend, content.publish, unknown) carry no send-layer PII duty here.
  if (!PER_RECIPIENT_KINDS.has(input.kind)) {
    return { allow: true, reason: null, rules };
  }

  // 1. Suppression — hard block, highest precedence. A targetless send can't be matched, so it can't be
  //    suppressed; but a per-recipient kind with no target is itself non-compliant (no opt-out subject).
  rules.push("suppression");
  if (input.target === null || input.target.trim() === "") {
    return {
      allow: false,
      reason: `${input.kind} requires a named recipient (no target to honor opt-out against)`,
      rules,
    };
  }
  if (input.suppressed) {
    return {
      allow: false,
      reason: `recipient ${input.target} is on the suppression list (unsubscribed/deleted) — send blocked`,
      rules,
    };
  }

  // 2. CAN-SPAM footer — email only.
  if (input.kind === "email.send") {
    rules.push("can_spam_footer");
    const footer = input.envelope?.footer;
    if (!footer?.unsubscribe) {
      return { allow: false, reason: "CAN-SPAM: a working unsubscribe mechanism is required", rules };
    }
    if (!footer.physicalAddress || footer.physicalAddress.trim() === "") {
      return { allow: false, reason: "CAN-SPAM: a physical postal address is required in the footer", rules };
    }

    // 3. CASL / GDPR consent — email only, when required.
    if (opts.requireConsent) {
      rules.push("consent");
      const declared = input.envelope?.consentBasis;
      const lawfulDeclared = declared === "contract" || declared === "legitimate_interest";
      if (!input.hasConsent && !lawfulDeclared) {
        return {
          allow: false,
          reason: `CASL/GDPR: no lawful basis to email ${input.target} (no consent record or declared basis)`,
          rules,
        };
      }
    }
  }

  return { allow: true, reason: null, rules };
}
