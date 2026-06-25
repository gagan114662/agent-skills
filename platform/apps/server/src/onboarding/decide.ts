import type {
  CapabilityDependency,
  CapabilityState,
  Reversibility,
  RequiredService,
  RotationCandidate,
  RotationReminder,
  ServiceKind,
  SetupRequestSpec,
} from "./types.js";

/**
 * The pure decision core for external account onboarding (#192, ADR-0192). No IO, no clock of its own —
 * every function is total and unit-tested. The IO orchestrator (`service.ts`) gathers inputs and persists
 * outputs; this only decides. Mirrors the #96/#107/#119 pure-core pattern.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Base reversibility per service kind (#200 failure-mode 4). A registrar (buying a domain) and a payment
 * account are MONEY → irreversible, and stay a human pre-commitment. Hosting/ad accounts are `cheap`
 * (recoverable spend). Pure key-based services (ESP/analytics) are `reversible`.
 */
export const REVERSIBILITY_BY_KIND: Record<ServiceKind, Reversibility> = {
  registrar: "irreversible",
  payment: "irreversible",
  hosting: "cheap",
  ad_account: "cheap",
  esp: "reversible",
  sms: "reversible",
  analytics: "reversible",
  other: "reversible",
};

/**
 * Classify a setup's reversibility. An irreversible kind stays irreversible regardless of cost. A
 * `reversible` kind that carries a recurring cost is at least `cheap` (money is now involved, so it's a
 * tracked decision even if the keys themselves can be rotated away).
 */
export function classifyReversibility(kind: ServiceKind, projectedCostCents: number): Reversibility {
  const base = REVERSIBILITY_BY_KIND[kind];
  if (base === "irreversible") return base;
  if (projectedCostCents > 0 && base === "reversible") return "cheap";
  return base;
}

/** A one-line human summary for the decision queue + checklist. */
export function buildSetupSummary(s: {
  displayName: string;
  serviceKind: ServiceKind;
  plan: string | null;
  projectedCostCents: number;
  reason: string;
}): string {
  const planPart = s.plan ? ` (${s.plan})` : "";
  const costPart =
    s.projectedCostCents > 0 ? ` ~$${(s.projectedCostCents / 100).toFixed(2)}/mo` : " (no cost)";
  return `Set up ${s.displayName}${planPart}${costPart} — ${s.reason}`;
}

/** Turn a declared required service into a fully-resolved SETUP request spec (acceptance 1). */
export function toSetupRequestSpec(req: RequiredService): SetupRequestSpec {
  const projectedCostCents = Math.max(0, Math.round(req.projectedCostCents ?? 0));
  const reversibility = classifyReversibility(req.serviceKind, projectedCostCents);
  const plan = req.plan ?? null;
  return {
    serviceKey: req.serviceKey,
    serviceKind: req.serviceKind,
    displayName: req.displayName,
    plan,
    scopes: req.scopes ?? [],
    reason: req.reason,
    projectedCostCents,
    reversibility,
    // An external account ALWAYS needs the owner: create the account, accept ToS, paste keys. Agents never do.
    requiresHuman: true,
    envKeys: req.envKeys ?? [],
    summary: buildSetupSummary({
      displayName: req.displayName,
      serviceKind: req.serviceKind,
      plan,
      projectedCostCents,
      reason: req.reason,
    }),
  };
}

/**
 * Needs detection (acceptance 1): given the services a venture requires and the set of service keys
 * already CONNECTED (non-revoked), return a SETUP request spec for each one still missing. A connected
 * service produces no request; a revoked one (absent from `connectedKeys`) is treated as missing again.
 */
export function decideSetupNeeded(
  required: RequiredService[],
  connectedKeys: ReadonlySet<string>,
): SetupRequestSpec[] {
  const seen = new Set<string>();
  const out: SetupRequestSpec[] = [];
  for (const req of required) {
    if (connectedKeys.has(req.serviceKey)) continue;
    if (seen.has(req.serviceKey)) continue; // dedupe duplicate declarations
    seen.add(req.serviceKey);
    out.push(toSetupRequestSpec(req));
  }
  return out;
}

/**
 * Whether autonomous work must PARK for setup (acceptance 5): true iff any required service is not yet
 * connected. The caller files the missing requests + a #13 pending approval instead of launching.
 */
export function shouldParkForSetup(
  required: RequiredService[],
  connectedKeys: ReadonlySet<string>,
): boolean {
  return decideSetupNeeded(required, connectedKeys).length > 0;
}

/**
 * Capability online/offline derivation (acceptance 4/5). A capability is ONLINE iff every service it
 * depends on is connected. Revoking a credential (removing its key from `connectedKeys`) flips dependent
 * capabilities offline gracefully, with a reason naming the missing services. Pure + deterministic.
 */
export function decideCapabilityStates(
  deps: CapabilityDependency[],
  connectedKeys: ReadonlySet<string>,
): CapabilityState[] {
  return deps.map((dep) => {
    const missing = dep.requiredServiceKeys.filter((k) => !connectedKeys.has(k));
    const online = missing.length === 0;
    return {
      capability: dep.capability,
      online,
      missingServices: missing,
      reason: online
        ? "all required services connected"
        : `offline — needs ${missing.join(", ")}`,
    };
  });
}

/**
 * Rotation reminders (acceptance 4): a connected credential older than its `rotationReminderDays` is due
 * for rotation. `dueInDays` is positive while not yet due, zero/negative once due; `overdueDays` is how
 * far past due it is (0 when not yet due). A candidate with `rotationReminderDays <= 0` is never reminded.
 */
export function decideRotationReminders(
  creds: RotationCandidate[],
  nowMs: number,
): RotationReminder[] {
  const out: RotationReminder[] = [];
  for (const c of creds) {
    if (c.rotationReminderDays <= 0) continue;
    const ageDays = Math.floor((nowMs - c.connectedAtMs) / MS_PER_DAY);
    const overdueDays = ageDays - c.rotationReminderDays;
    if (overdueDays < 0) continue; // not yet due
    out.push({
      serviceKey: c.serviceKey,
      ageDays,
      dueInDays: -overdueDays,
      overdueDays,
    });
  }
  return out;
}
