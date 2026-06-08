import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { approvalRequests, governancePolicies } from "../schema/index.js";
import {
  DEFAULT_POLICY,
  type ActionKind,
  type ApprovalStatus,
  type GovernancePolicy,
} from "../../governance/policy.js";

/** One persisted approval request — the #13 audit record. */
export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  requestedByMemberId: string;
  actionKind: ActionKind;
  actionSummary: string;
  action: Record<string, unknown>;
  channelId: string | null;
  status: ApprovalStatus;
  policyReason: string | null;
  decidedByMemberId: string | null;
  decisionReason: string | null;
  outcome: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  executedAt: Date | null;
  expiresAt: Date | null;
}

const COLUMNS = {
  id: approvalRequests.id,
  workspaceId: approvalRequests.workspaceId,
  requestedByMemberId: approvalRequests.requestedByMemberId,
  actionKind: approvalRequests.actionKind,
  actionSummary: approvalRequests.actionSummary,
  action: approvalRequests.action,
  channelId: approvalRequests.channelId,
  status: approvalRequests.status,
  policyReason: approvalRequests.policyReason,
  decidedByMemberId: approvalRequests.decidedByMemberId,
  decisionReason: approvalRequests.decisionReason,
  outcome: approvalRequests.outcome,
  createdAt: approvalRequests.createdAt,
  decidedAt: approvalRequests.decidedAt,
  executedAt: approvalRequests.executedAt,
  expiresAt: approvalRequests.expiresAt,
} as const;

/** Persist a new request. `status` is `pending` for a gated action or `auto_approved` otherwise. */
export async function createApprovalRequest(input: {
  workspaceId: string;
  requestedByMemberId: string;
  actionKind: ActionKind;
  actionSummary: string;
  action: Record<string, unknown>;
  channelId?: string | null;
  status: ApprovalStatus;
  policyReason: string;
  expiresAt?: Date | null;
}): Promise<ApprovalRequest> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      workspaceId: input.workspaceId,
      requestedByMemberId: input.requestedByMemberId,
      actionKind: input.actionKind,
      actionSummary: input.actionSummary,
      action: input.action,
      channelId: input.channelId ?? null,
      status: input.status,
      policyReason: input.policyReason,
      expiresAt: input.expiresAt ?? null,
    })
    .returning(COLUMNS);
  return row as ApprovalRequest;
}

/** Fetch one request scoped to its workspace (the #3 IDOR guard — cross-tenant ids are invisible). */
export async function getApprovalRequest(
  id: string,
  workspaceId: string,
): Promise<ApprovalRequest | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.workspaceId, workspaceId)))
    .limit(1);
  return row as ApprovalRequest | undefined;
}

/** The audit list for a workspace, newest first; optional status / requester filters. */
export async function listApprovalRequests(
  workspaceId: string,
  opts: { status?: ApprovalStatus; requestedByMemberId?: string } = {},
): Promise<ApprovalRequest[]> {
  const where = [eq(approvalRequests.workspaceId, workspaceId)];
  if (opts.status) where.push(eq(approvalRequests.status, opts.status));
  if (opts.requestedByMemberId) {
    where.push(eq(approvalRequests.requestedByMemberId, opts.requestedByMemberId));
  }
  const rows = await db
    .select(COLUMNS)
    .from(approvalRequests)
    .where(and(...where))
    .orderBy(desc(approvalRequests.createdAt));
  return rows as ApprovalRequest[];
}

/**
 * Atomically resolve a request to a terminal status — but ONLY if it is still `pending`. The
 * `status = 'pending'` predicate is the audit-integrity / TOCTOU guard: a terminal row never
 * matches, so a request can never be re-decided and two concurrent decisions can't both win.
 * Returns the updated row, or undefined when the row was not pending (already decided / expired).
 */
export async function resolvePendingRequest(
  id: string,
  workspaceId: string,
  fields: {
    status: Extract<ApprovalStatus, "approved" | "rejected" | "expired">;
    decidedByMemberId?: string | null;
    decisionReason?: string | null;
    decidedAt: Date;
  },
): Promise<ApprovalRequest | undefined> {
  const [row] = await db
    .update(approvalRequests)
    .set({
      status: fields.status,
      decidedByMemberId: fields.decidedByMemberId ?? null,
      decisionReason: fields.decisionReason ?? null,
      decidedAt: fields.decidedAt,
    })
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .returning(COLUMNS);
  return row as ApprovalRequest | undefined;
}

/** Record the executor's outcome after an approved/auto-approved action has run. */
export async function recordExecution(
  id: string,
  workspaceId: string,
  outcome: string,
  executedAt: Date,
): Promise<void> {
  await db
    .update(approvalRequests)
    .set({ outcome, executedAt })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.workspaceId, workspaceId)));
}

/** Coerce a jsonb value into a string[] (defensive — the column is an untyped jsonb array). */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A workspace's governance policy, or the defaults (gate external sends + spend) when unset. */
export async function getGovernancePolicy(workspaceId: string): Promise<GovernancePolicy> {
  const [row] = await db
    .select({
      spendThresholdCents: governancePolicies.spendThresholdCents,
      externalSendRequiresApproval: governancePolicies.externalSendRequiresApproval,
      requireApprovalFor: governancePolicies.requireApprovalFor,
      guardedChannelIds: governancePolicies.guardedChannelIds,
      defaultTtlMs: governancePolicies.defaultTtlMs,
    })
    .from(governancePolicies)
    .where(eq(governancePolicies.workspaceId, workspaceId))
    .limit(1);
  if (!row) return DEFAULT_POLICY;
  return {
    spendThresholdCents: row.spendThresholdCents,
    externalSendRequiresApproval: row.externalSendRequiresApproval,
    requireApprovalFor: toStringArray(row.requireApprovalFor) as GovernancePolicy["requireApprovalFor"],
    guardedChannelIds: toStringArray(row.guardedChannelIds),
    defaultTtlMs: row.defaultTtlMs,
  };
}

/** Upsert a workspace's policy (partial patch merged over the current/default values). */
export async function upsertGovernancePolicy(
  workspaceId: string,
  patch: Partial<GovernancePolicy>,
): Promise<GovernancePolicy> {
  const current = await getGovernancePolicy(workspaceId);
  const next: GovernancePolicy = {
    spendThresholdCents: patch.spendThresholdCents ?? current.spendThresholdCents,
    externalSendRequiresApproval:
      patch.externalSendRequiresApproval ?? current.externalSendRequiresApproval,
    requireApprovalFor: patch.requireApprovalFor ?? current.requireApprovalFor,
    guardedChannelIds: patch.guardedChannelIds ?? current.guardedChannelIds,
    defaultTtlMs: patch.defaultTtlMs ?? current.defaultTtlMs,
  };
  await db
    .insert(governancePolicies)
    .values({ workspaceId, ...next })
    .onConflictDoUpdate({
      target: governancePolicies.workspaceId,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}
