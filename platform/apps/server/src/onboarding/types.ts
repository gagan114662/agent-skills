/**
 * External account onboarding types (#192, ADR-0192). Pure data shapes shared by the decide core, the
 * service orchestrator, the DNS adapter, and the routes. No IO here.
 */

export type ServiceKind =
  | "esp"
  | "ad_account"
  | "analytics"
  | "registrar"
  | "hosting"
  | "payment"
  | "other";

/**
 * Reversibility class (#200 failure-mode 4). Drives the premortem irreversible-action count and whether
 * the setup is a pre-committed human decision. A domain purchase / payment account is MONEY → irreversible.
 */
export type Reversibility = "reversible" | "cheap" | "irreversible";

export type SetupRequestStatus = "requested" | "connected" | "dismissed";
export type CredentialStatusKind = "connected" | "revoked";

/** A service a venture declares it needs (acceptance 1 input). */
export interface RequiredService {
  serviceKey: string;
  serviceKind: ServiceKind;
  displayName: string;
  plan?: string | null;
  scopes?: string[];
  reason: string;
  /** Projected monthly cost (cents) the owner commits to — the money signal. */
  projectedCostCents?: number;
  /** Env var names the agents will use once connected (e.g. ["SENDGRID_API_KEY"]). */
  envKeys?: string[];
}

/** The SETUP request the fleet files (acceptance 1): which service, plan, scopes, why, projected cost. */
export interface SetupRequestSpec {
  serviceKey: string;
  serviceKind: ServiceKind;
  displayName: string;
  plan: string | null;
  scopes: string[];
  reason: string;
  projectedCostCents: number;
  reversibility: Reversibility;
  /**
   * Always true for an external account: the owner creates the account, accepts the ToS, and pastes the
   * keys — agents never do (the core directive). Carried explicitly so the queue/checklist can say so.
   */
  requiresHuman: boolean;
  envKeys: string[];
  /** One-line summary for the #13 decision queue + the Slack/console checklist. */
  summary: string;
}

/** A capability that depends on one or more external services being connected (acceptance 4/5). */
export interface CapabilityDependency {
  capability: string;
  requiredServiceKeys: string[];
}

/** The derived online/offline state of a capability given current credential connectivity. */
export interface CapabilityState {
  capability: string;
  online: boolean;
  missingServices: string[];
  reason: string;
}

/** A connected credential's rotation inputs (acceptance 4). */
export interface RotationCandidate {
  serviceKey: string;
  connectedAtMs: number;
  /** Days after connection a rotation is recommended. 0 ⇒ no reminder. */
  rotationReminderDays: number;
}

/** A due rotation reminder. */
export interface RotationReminder {
  serviceKey: string;
  ageDays: number;
  dueInDays: number;
  overdueDays: number;
}
