/**
 * Production send-layer compliance enforcer (#196, ADR-0196). Implements the {@link ComplianceEnforcer}
 * seam the #13 `external.send` executor calls at the one physical send chokepoint. It is the IO half of
 * the pure {@link decideCompliance}: it resolves the tenant's legal caps (#58), looks up suppression +
 * consent state, applies the rule, records the decision to the append-only `compliance_events` audit, and
 * returns a block reason (or null to allow).
 *
 * **Default OFF.** When the tenant has not turned the legal pack on (`legal.enabled !== true`) this is a
 * no-op (returns null) — so existing deployments + every approval test are byte-for-byte unchanged, and
 * the owner workspace opts into real send-blocking first. Mirrors how `defaultEgressEnforcer` returns null
 * when the #58 allowlist is off.
 */
import type { ComplianceEnforcer } from "../approvals/runtime.js";
import { decideCompliance } from "./compliance.js";
import { resolveLegalCaps } from "./caps.js";
import { loadConfig } from "../config/loader.js";
import { dbConsentStore, dbSuppressionStore, recordComplianceEvent } from "../db/repositories/legal.js";
import type { ComplianceEnvelope, ConsentBasis, ComplianceFooter } from "./types.js";

/** The send kinds the legal pack governs per-recipient. Other kinds (ad.spend, content.publish, naming
 * decisions) carry no per-recipient PII duty here and are skipped entirely (no lookups, no audit row). */
const GOVERNED_KINDS = new Set(["email.send", "social.post"]);

/** Narrow an untyped payload envelope into a typed {@link ComplianceEnvelope}. */
function parseEnvelope(raw: Record<string, unknown> | undefined): ComplianceEnvelope | undefined {
  if (!raw) return undefined;
  const out: ComplianceEnvelope = {};
  if (raw.footer && typeof raw.footer === "object") {
    const f = raw.footer as Record<string, unknown>;
    const footer: ComplianceFooter = { unsubscribe: f.unsubscribe === true };
    if (typeof f.physicalAddress === "string") footer.physicalAddress = f.physicalAddress;
    out.footer = footer;
  }
  if (raw.consentBasis === "opt_in" || raw.consentBasis === "contract" || raw.consentBasis === "legitimate_interest") {
    out.consentBasis = raw.consentBasis as ConsentBasis;
  }
  return out;
}

export const defaultComplianceEnforcer: ComplianceEnforcer = {
  async enforce(input) {
    const caps = resolveLegalCaps(loadConfig(input.workspaceId).legal);
    // Pack OFF ⇒ no-op (today's behavior). Owner workspace opts in first.
    if (!caps.enabled) return null;
    // Kinds with no per-recipient obligation pass straight through (no lookup / no audit noise).
    if (!GOVERNED_KINDS.has(input.kind)) return null;

    const target = input.target;
    const [suppressed, hasConsent] = await Promise.all([
      target ? dbSuppressionStore.isSuppressed(input.workspaceId, target) : Promise.resolve(false),
      target ? dbConsentStore.hasConsent(input.workspaceId, target) : Promise.resolve(false),
    ]);

    const decision = decideCompliance(
      { kind: input.kind, target, envelope: parseEnvelope(input.envelope), suppressed, hasConsent },
      { requireConsent: caps.requireConsentForEmail },
    );

    await recordComplianceEvent({
      workspaceId: input.workspaceId,
      kind: input.kind,
      target,
      decision: decision.allow ? "allow" : "block",
      reason: decision.reason,
      rules: decision.rules,
      actorMemberId: input.actorMemberId,
    });

    return decision.allow ? null : decision.reason;
  },
};
