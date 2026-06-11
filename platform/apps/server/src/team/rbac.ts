/**
 * Workspace RBAC — pure role policy (issue #151, ADR-0151).
 *
 * Today a workspace has no modeled owner and every human member can clear any #13 approval. This module
 * introduces three workspace-level roles and the pure decisions over them. It holds **no** DB access and
 * **no** Fastify — it is the testable core the `requireWorkspaceRole` guard, the governance routes, and
 * the approvals routes consult.
 *
 * The roles only ever *tighten*: the role gate is applied **on top of** the existing #13 `requireHuman`
 * check and **only when RBAC is enabled** for the workspace. With RBAC off (the default) or a member
 * with no role row, callers keep today's "any human member clears" behavior — so enabling this can never
 * weaken an existing gate, only add a requirement (ADR-0151 §3).
 */

/** The workspace roles, ordered low → high authority. `owner` ⊃ `approver` ⊃ `viewer`. */
export const WORKSPACE_ROLES = ["viewer", "approver", "owner"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Lifecycle of an email invite. `pending` → `accepted` (member created) | `revoked` (owner cancels). */
export const INVITE_STATUSES = ["pending", "accepted", "revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** Numeric authority so guards can express "at least approver". Higher = more authority. */
const RANK: Record<WorkspaceRole, number> = { viewer: 1, approver: 2, owner: 3 };

/** Resolve the #58 config partial into the RBAC posture, defaulting to OFF (any human member clears). */
export function resolveRbacConfig(config: { enabled?: boolean } | undefined): { enabled: boolean } {
  return { enabled: config?.enabled ?? false };
}

/** Total/pure: is `value` one of the three roles? (route input validation). */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** Authority rank of a role (1..3). */
export function roleRank(role: WorkspaceRole): number {
  return RANK[role];
}

/** True iff `have` is at least as authoritative as `needed` (the guard's at-least check). */
export function roleSatisfies(have: WorkspaceRole, needed: WorkspaceRole): boolean {
  return RANK[have] >= RANK[needed];
}

/** Only `approver`/`owner` may clear (approve/reject) a #13 approval; `viewer` cannot. */
export function canClearApprovals(role: WorkspaceRole): boolean {
  return roleSatisfies(role, "approver");
}

/** Only `owner` may manage governance: assign roles, send/revoke invites, edit the credential matrix. */
export function canManageGovernance(role: WorkspaceRole): boolean {
  return role === "owner";
}

/** `viewer` is strictly read-only — the highest-friction lock-out, surfaced for UI affordances. */
export function isReadOnly(role: WorkspaceRole): boolean {
  return role === "viewer";
}

/** A minimal, dependency-free email shape check for invites (not RFC-perfect — just non-garbage). */
export function isLikelyEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

export interface InviteDecision {
  ok: boolean;
  /** Normalised (trimmed, lower-cased) email when ok. */
  email?: string;
  role?: WorkspaceRole;
  reason?: string;
}

/**
 * Pure validation of an invite request. The actor's authority is checked by the caller's guard; this
 * validates the *payload* (a real-looking email + a known role) and normalises the email so duplicate
 * invites collide deterministically.
 */
export function decideInvite(input: { email?: unknown; role?: unknown }): InviteDecision {
  if (!isLikelyEmail(input.email)) return { ok: false, reason: "a valid email is required" };
  if (!isWorkspaceRole(input.role)) {
    return { ok: false, reason: `role must be one of ${WORKSPACE_ROLES.join(", ")}` };
  }
  return { ok: true, email: String(input.email).trim().toLowerCase(), role: input.role };
}

/**
 * The effective enforcement decision for clearing an approval, given the RBAC posture. Pure so both the
 * route and its test share one source of truth.
 *
 * - RBAC disabled → `allow` (today's behavior: the #13 `requireHuman` gate is the only check).
 * - RBAC enabled + a role that can clear → `allow`.
 * - RBAC enabled + a role that cannot (viewer) → `deny`.
 * - RBAC enabled + **no role row** → `allow` (no lock-out from merely turning RBAC on without assigning
 *   roles; an owner must assign roles to actually restrict — never a silent loss of access).
 */
export function decideApprovalClear(input: {
  rbacEnabled: boolean;
  role: WorkspaceRole | null;
}): { decision: "allow" | "deny"; reason?: string } {
  if (!input.rbacEnabled) return { decision: "allow" };
  if (input.role === null) return { decision: "allow" };
  return canClearApprovals(input.role)
    ? { decision: "allow" }
    : { decision: "deny", reason: "your role is read-only; an approver or owner must clear approvals" };
}
