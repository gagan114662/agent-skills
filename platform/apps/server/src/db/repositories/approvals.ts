import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "../index.js";
import {
  approvalPolicies,
  approvalRequests,
  approvalEvents,
  members,
} from "../schema/index.js";
import type { ApprovalStatus, PolicyRule } from "../../approvals/policy.js";

// ---- policy rules -----------------------------------------------------------------------------

export interface ApprovalPolicy {
  id: string;
  actionType: string;
  requireApproval: boolean;
  maxAutoAmount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const POLICY_COLUMNS = {
  id: approvalPolicies.id,
  actionType: approvalPolicies.actionType,
  requireApproval: approvalPolicies.requireApproval,
  maxAutoAmount: approvalPolicies.maxAutoAmount,
  createdAt: approvalPolicies.createdAt,
  updatedAt: approvalPolicies.updatedAt,
} as const;

/** Upsert a workspace policy rule (idempotent per the (workspace, action_type) UNIQUE). */
export async function upsertPolicy(input: {
  workspaceId: string;
  actionType: string;
  requireApproval: boolean;
  maxAutoAmount: number | null;
  createdByMemberId: string;
}): Promise<ApprovalPolicy> {
  const [row] = await db
    .insert(approvalPolicies)
    .values({
      workspaceId: input.workspaceId,
      actionType: input.actionType,
      requireApproval: input.requireApproval,
      maxAutoAmount: input.maxAutoAmount,
      createdByMemberId: input.createdByMemberId,
    })
    .onConflictDoUpdate({
      target: [approvalPolicies.workspaceId, approvalPolicies.actionType],
      set: {
        requireApproval: input.requireApproval,
        maxAutoAmount: input.maxAutoAmount,
        updatedAt: new Date(),
      },
    })
    .returning(POLICY_COLUMNS);
  return row as ApprovalPolicy;
}

export async function listPolicies(workspaceId: string): Promise<ApprovalPolicy[]> {
  const rows = await db
    .select(POLICY_COLUMNS)
    .from(approvalPolicies)
    .where(eq(approvalPolicies.workspaceId, workspaceId))
    .orderBy(asc(approvalPolicies.actionType));
  return rows as ApprovalPolicy[];
}

/** Policy rules in the shape the pure engine consumes (`evaluatePolicy`). */
export async function listPolicyRules(workspaceId: string): Promise<PolicyRule[]> {
  const rows = await listPolicies(workspaceId);
  return rows.map((r) => ({
    actionType: r.actionType,
    requiresApproval: r.requireApproval,
    maxAutoAmount: r.maxAutoAmount,
  }));
}

/**
 * Policy rules carrying their id — `evaluatePolicy`-compatible plus the id of the rule that matched,
 * so a policy-driven auto-approval can be audited to the exact rule (#84 follow-up, ADR-0042). Used by
 * the autonomy engine's `completionPolicies` seam; the extra `id` is ignored by `evaluatePolicy`.
 */
export async function listPolicyRulesWithId(
  workspaceId: string,
): Promise<(PolicyRule & { id: string })[]> {
  const rows = await listPolicies(workspaceId);
  return rows.map((r) => ({
    id: r.id,
    actionType: r.actionType,
    requiresApproval: r.requireApproval,
    maxAutoAmount: r.maxAutoAmount,
  }));
}

export async function deletePolicy(id: string, workspaceId: string): Promise<boolean> {
  const deleted = await db
    .delete(approvalPolicies)
    .where(and(eq(approvalPolicies.id, id), eq(approvalPolicies.workspaceId, workspaceId)))
    .returning({ id: approvalPolicies.id });
  return deleted.length > 0;
}

// ---- requests ---------------------------------------------------------------------------------

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  requesterMemberId: string;
  actionType: string;
  payload: Record<string, unknown>;
  amount: number | null;
  summary: string;
  status: ApprovalStatus;
  reason: string | null;
  decidedByMemberId: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const REQUEST_COLUMNS = {
  id: approvalRequests.id,
  workspaceId: approvalRequests.workspaceId,
  requesterMemberId: approvalRequests.requesterMemberId,
  actionType: approvalRequests.actionType,
  payload: approvalRequests.payload,
  amount: approvalRequests.amount,
  summary: approvalRequests.summary,
  status: approvalRequests.status,
  reason: approvalRequests.reason,
  decidedByMemberId: approvalRequests.decidedByMemberId,
  decidedAt: approvalRequests.decidedAt,
  expiresAt: approvalRequests.expiresAt,
  result: approvalRequests.result,
  error: approvalRequests.error,
  createdAt: approvalRequests.createdAt,
  updatedAt: approvalRequests.updatedAt,
} as const;

export interface ApprovalEvent {
  id: string;
  requestId: string;
  type: string;
  actorMemberId: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

type ApprovalEventType =
  | "requested"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "failed";

/**
 * Create a request in a given terminal-or-pending status and append its opening event(s), atomically
 * (ADR-0013 §7). For a gated submit this is `pending` + a `requested` event; for an auto-approved
 * submit it's `executed` + `requested`/`executed` events, so every gated path is auditable.
 */
export async function createRequest(input: {
  workspaceId: string;
  requesterMemberId: string;
  actionType: string;
  payload: Record<string, unknown>;
  amount: number | null;
  summary: string;
  status: ApprovalStatus;
  expiresAt: Date | null;
  result?: Record<string, unknown> | null;
  events: { type: ApprovalEventType; detail?: Record<string, unknown> }[];
}): Promise<ApprovalRequest> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: input.actionType,
        payload: input.payload,
        amount: input.amount,
        summary: input.summary,
        status: input.status,
        expiresAt: input.expiresAt,
        result: input.result ?? null,
      })
      .returning(REQUEST_COLUMNS);
    const request = row as ApprovalRequest;
    for (const e of input.events) {
      await tx.insert(approvalEvents).values({
        workspaceId: request.workspaceId,
        requestId: request.id,
        type: e.type,
        actorMemberId: request.requesterMemberId,
        detail: e.detail ?? {},
      });
    }
    return request;
  });
}

export async function getRequest(id: string): Promise<ApprovalRequest | undefined> {
  const [row] = await db
    .select(REQUEST_COLUMNS)
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  return row as ApprovalRequest | undefined;
}

export async function listRequests(
  workspaceId: string,
  filters: { status?: ApprovalStatus } = {},
): Promise<ApprovalRequest[]> {
  const where = [eq(approvalRequests.workspaceId, workspaceId)];
  if (filters.status) where.push(eq(approvalRequests.status, filters.status));
  const rows = await db
    .select(REQUEST_COLUMNS)
    .from(approvalRequests)
    .where(and(...where))
    .orderBy(desc(approvalRequests.createdAt));
  return rows as ApprovalRequest[];
}

export async function listRequestEvents(requestId: string): Promise<ApprovalEvent[]> {
  const rows = await db
    .select({
      id: approvalEvents.id,
      requestId: approvalEvents.requestId,
      type: approvalEvents.type,
      actorMemberId: approvalEvents.actorMemberId,
      detail: approvalEvents.detail,
      createdAt: approvalEvents.createdAt,
    })
    .from(approvalEvents)
    .where(eq(approvalEvents.requestId, requestId))
    .orderBy(asc(approvalEvents.createdAt), asc(approvalEvents.id));
  return rows as ApprovalEvent[];
}

// ---- decision transitions ---------------------------------------------------------------------

/** The human members of a workspace other than `exceptMemberId` — the reviewers to notify (#8). */
export async function listHumanReviewers(
  workspaceId: string,
  exceptMemberId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.kind, "human")));
  return rows.map((r) => r.id).filter((id) => id !== exceptMemberId);
}

/** Outcome of a decision attempt. `conflict` = already decided; `expired` = the TTL fired first. */
export type DecisionOutcome =
  | { outcome: "approved"; request: ApprovalRequest }
  | { outcome: "rejected"; request: ApprovalRequest }
  | { outcome: "expired"; request: ApprovalRequest }
  | { outcome: "conflict" };

/**
 * Atomically move a pending request to `approved`, the guarded transition that prevents a double
 * approve (ADR-0013 §5). If the request is already past its TTL it is expired instead (a `409` at the
 * route, never an execution). Appends the matching audit event in the same transaction. The winner
 * receives `{ outcome:'approved', request }` and is the only caller that proceeds to execute.
 */
export async function approveAndLock(
  requestId: string,
  workspaceId: string,
  deciderMemberId: string,
  reason: string | null,
): Promise<DecisionOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: approvalRequests.status, expiresAt: approvalRequests.expiresAt })
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.id, requestId), eq(approvalRequests.workspaceId, workspaceId)),
      )
      .limit(1)
      .for("update");
    if (!current || current.status !== "pending") return { outcome: "conflict" } as const;

    if (current.expiresAt !== null && current.expiresAt.getTime() <= Date.now()) {
      const [row] = await tx
        .update(approvalRequests)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(approvalRequests.id, requestId))
        .returning(REQUEST_COLUMNS);
      await tx.insert(approvalEvents).values({
        workspaceId,
        requestId,
        type: "expired",
        actorMemberId: deciderMemberId,
      });
      return { outcome: "expired", request: row as ApprovalRequest } as const;
    }

    const [row] = await tx
      .update(approvalRequests)
      .set({
        status: "approved",
        decidedByMemberId: deciderMemberId,
        decidedAt: new Date(),
        reason,
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, requestId))
      .returning(REQUEST_COLUMNS);
    await tx.insert(approvalEvents).values({
      workspaceId,
      requestId,
      type: "approved",
      actorMemberId: deciderMemberId,
      detail: reason ? { reason } : {},
    });
    return { outcome: "approved", request: row as ApprovalRequest } as const;
  });
}

/** Record the outcome of executing an approved request: `executed` (result) or `failed` (error). */
export async function recordExecution(
  requestId: string,
  workspaceId: string,
  outcome: { ok: true; result: Record<string, unknown> } | { ok: false; error: string },
): Promise<ApprovalRequest> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvalRequests)
      .set(
        outcome.ok
          ? { status: "executed", result: outcome.result, updatedAt: new Date() }
          : { status: "failed", error: outcome.error, updatedAt: new Date() },
      )
      .where(eq(approvalRequests.id, requestId))
      .returning(REQUEST_COLUMNS);
    await tx.insert(approvalEvents).values({
      workspaceId,
      requestId,
      type: outcome.ok ? "executed" : "failed",
      detail: outcome.ok ? outcome.result : { error: outcome.error },
    });
    return row as ApprovalRequest;
  });
}

/**
 * Reject a pending request (guarded transition). Lazy-expires a due request first. Appends the audit
 * event in the same transaction. Returns the decision outcome (`rejected` / `expired` / `conflict`).
 */
export async function rejectRequest(
  requestId: string,
  workspaceId: string,
  deciderMemberId: string,
  reason: string | null,
): Promise<DecisionOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: approvalRequests.status, expiresAt: approvalRequests.expiresAt })
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.id, requestId), eq(approvalRequests.workspaceId, workspaceId)),
      )
      .limit(1)
      .for("update");
    if (!current || current.status !== "pending") return { outcome: "conflict" } as const;

    if (current.expiresAt !== null && current.expiresAt.getTime() <= Date.now()) {
      const [row] = await tx
        .update(approvalRequests)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(approvalRequests.id, requestId))
        .returning(REQUEST_COLUMNS);
      await tx.insert(approvalEvents).values({
        workspaceId,
        requestId,
        type: "expired",
        actorMemberId: deciderMemberId,
      });
      return { outcome: "expired", request: row as ApprovalRequest } as const;
    }

    const [row] = await tx
      .update(approvalRequests)
      .set({
        status: "rejected",
        decidedByMemberId: deciderMemberId,
        decidedAt: new Date(),
        reason,
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, requestId))
      .returning(REQUEST_COLUMNS);
    await tx.insert(approvalEvents).values({
      workspaceId,
      requestId,
      type: "rejected",
      actorMemberId: deciderMemberId,
      detail: reason ? { reason } : {},
    });
    return { outcome: "rejected", request: row as ApprovalRequest } as const;
  });
}

/**
 * Bulk-expire every pending request whose TTL has passed (the housekeeping sweep, ADR-0013 §6).
 * Appends an `expired` event per request in one transaction. Returns the number expired.
 */
export async function sweepExpired(workspaceId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const due = await tx
      .update(approvalRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.workspaceId, workspaceId),
          eq(approvalRequests.status, "pending"),
          lte(approvalRequests.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: approvalRequests.id });
    for (const r of due) {
      await tx.insert(approvalEvents).values({
        workspaceId,
        requestId: r.id,
        type: "expired",
      });
    }
    return due.length;
  });
}
