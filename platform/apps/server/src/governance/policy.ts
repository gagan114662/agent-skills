/**
 * Approval-gate policy engine (issue #13, ADR-0013). Pure and dependency-free — the single source
 * of truth for "does this action need a human?", mirroring the `notifications/types.ts` /
 * `tasks/status.ts` pure-logic pattern so it runs in the no-DB/no-Redis unit job and is validated
 * the same way everywhere. Persistence, notification, and execution live in the service.
 */

/** The kinds of sensitive action #13 can gate (the four levers: types / spend / channels / external). */
export const ACTION_KINDS = ["external_send", "spend", "channel_post", "custom"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === "string" && (ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * The approval request lifecycle. `pending` is the only non-terminal state; `auto_approved` is the
 * create-time terminal for an action the policy did not gate. A terminal row is immutable (the audit
 * integrity guard) — only a `pending` row can be resolved.
 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "auto_approved",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** True when `status` can still be approved/rejected (i.e. it is `pending`). */
export function canResolve(status: ApprovalStatus): boolean {
  return status === "pending";
}

/** True when `status` is terminal (can never be re-decided). */
export function isTerminal(status: ApprovalStatus): boolean {
  return !canResolve(status);
}

/**
 * A sensitive action an agent wants to take — the **preview** a human approves. `summary` is the
 * human-readable description; the kind-specific fields drive the policy evaluation; `metadata` is
 * an opaque descriptor persisted for audit/replay.
 */
export interface SensitiveAction {
  kind: ActionKind;
  summary: string;
  /** For `spend`: the amount in minor units (cents). */
  amountCents?: number;
  /** For `spend`: an ISO 4217 currency code (audit only). */
  currency?: string;
  /** For `channel_post`: the target channel. */
  channelId?: string;
  /** For `external_send`: where the data is going (audit only). */
  destination?: string;
  /** Opaque, action-specific descriptor persisted with the request. */
  metadata?: Record<string, unknown>;
}

/** Per-workspace governance policy (the four levers + a TTL). */
export interface GovernancePolicy {
  /** Every `external_send` requires approval. */
  externalSendRequiresApproval: boolean;
  /** A `spend` requires approval when `amountCents` is strictly greater than this. */
  spendThresholdCents: number;
  /** A `channel_post` into one of these channels requires approval. */
  guardedChannelIds: string[];
  /** Action kinds that ALWAYS require approval, regardless of the other levers. */
  requireApprovalFor: ActionKind[];
  /** TTL (ms) applied to a new pending request; past it, the request expires. */
  defaultTtlMs: number;
}

/** Policy applied when a workspace has no row yet. */
export const DEFAULT_POLICY: GovernancePolicy = {
  externalSendRequiresApproval: true,
  spendThresholdCents: 0,
  guardedChannelIds: [],
  requireApprovalFor: [],
  defaultTtlMs: 86_400_000, // 24h
};

/** The verdict of the policy engine: gate or not, plus an audit-friendly reason. */
export interface PolicyVerdict {
  required: boolean;
  reason: string;
}

/**
 * Decide whether `action` requires human approval under `policy`. An explicit `requireApprovalFor`
 * entry wins over everything; otherwise the kind-specific lever applies; otherwise the action is
 * allowed (auto). `reason` is a short, stable string suitable for the audit log.
 */
export function evaluatePolicy(action: SensitiveAction, policy: GovernancePolicy): PolicyVerdict {
  if (policy.requireApprovalFor.includes(action.kind)) {
    return { required: true, reason: `kind '${action.kind}' always requires approval` };
  }

  switch (action.kind) {
    case "external_send":
      return policy.externalSendRequiresApproval
        ? { required: true, reason: "external send requires approval" }
        : { required: false, reason: "auto: external sends allowed by policy" };
    case "spend": {
      const amount = action.amountCents ?? 0;
      return amount > policy.spendThresholdCents
        ? { required: true, reason: `spend ${amount} > threshold ${policy.spendThresholdCents}` }
        : { required: false, reason: `auto: spend ${amount} within threshold ${policy.spendThresholdCents}` };
    }
    case "channel_post":
      return action.channelId && policy.guardedChannelIds.includes(action.channelId)
        ? { required: true, reason: `channel ${action.channelId} is guarded` }
        : { required: false, reason: "auto: channel not guarded" };
    case "custom":
      return { required: false, reason: "auto: policy allows" };
  }
}

/** True once `now` is at or past `expiresAt` (null ⇒ never expires). */
export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && now.getTime() >= expiresAt.getTime();
}
