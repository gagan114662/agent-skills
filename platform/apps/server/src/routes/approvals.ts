import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireApprovalInWorkspace } from "../auth/access.js";
import type { Identity } from "../auth/identity.js";
import { loadEnv } from "../env.js";
import { loadConfig } from "../config/loader.js";
import { getMemberRole } from "../db/repositories/governance.js";
import { decideApprovalClear, resolveRbacConfig, type WorkspaceRole } from "../team/rbac.js";
import { notify } from "../notifications/service.js";
import { evaluatePolicy, isActionType, isApprovalStatus } from "../approvals/policy.js";
import { fireApprovalPending } from "../approvals/pending-hook.js";
import { collapseDuplicateDeliverables, resolveDedupeEnabled } from "../marketing/dedup.js";
import { departmentForHandle } from "../marketing/blueprint.js";
import { createCoordinationChannelBridge } from "../agent-channel-bridge/default.js";
import { defaultRegistry, ActionExecutionError } from "../approvals/runtime.js";
import { executeApprovedRequest } from "../approvals/execute.js";
import type { ExecutorRegistry } from "../approvals/executor.js";
import {
  upsertPolicy,
  listPolicies,
  listPolicyRules,
  deletePolicy,
  createRequest,
  listRequests,
  listRequestEvents,
  listHumanReviewers,
  approveAndLock,
  rejectRequest,
  sweepExpired,
  type ApprovalRequest,
} from "../db/repositories/approvals.js";

/**
 * Human approval gates & governance (issue #13, ADR-0013). A member submits an action; the pure
 * policy engine decides whether it pauses for a human. Gated actions become a pending request that
 * only a **human** member can approve (→ execute) or reject (→ block); undecided requests expire.
 * Every transition is an append-only audit event. Routes stay thin: one access helper + pure
 * functions, logic in the repo (the #9/#14 pattern). The executor registry is injectable for tests.
 */
export interface ApprovalRoutesOptions {
  registry?: ExecutorRegistry;
  /** #151 RBAC seams (injected in tests). Default: per-tenant config + the governance repo. */
  rbacEnabled?: (workspaceId: string) => boolean;
  loadMemberRole?: (workspaceId: string, memberId: string) => Promise<WorkspaceRole | null>;
}

/** A decision (approve/reject) is restricted to human members — "humans only on critical decisions". */
function requireHuman(id: Identity, reply: FastifyReply): boolean {
  if (id.kind !== "human") {
    void reply.code(403).send({ error: "only human members can decide approvals" });
    return false;
  }
  return true;
}

export async function approvalRoutes(
  app: FastifyInstance,
  opts: ApprovalRoutesOptions = {},
): Promise<void> {
  const registry = opts.registry ?? defaultRegistry;
  const rbacEnabled = opts.rbacEnabled ?? ((wid: string) => resolveRbacConfig(loadConfig(wid).rbac).enabled);
  const loadMemberRole = opts.loadMemberRole ?? getMemberRole;
  // #370: when an AGENT's action pauses for a human, the agent @mentions the owner in-channel to surface
  // this pending #13 gate. Best-effort, gated default-OFF + owner-first — this only NARRATES the existing
  // gate; it adds no action path and the gate itself is unchanged. Posts nothing unless posting is enabled.
  const coordinationBridge = createCoordinationChannelBridge();

  /**
   * #151: gate clearing an approval on the caller's workspace role when RBAC is enabled. Additive on top
   * of `requireHuman` — with RBAC OFF (default) or a member with no role row, this allows (today's
   * behavior). A `viewer` is 403. Sends the response + returns false on deny.
   */
  async function requireCanClear(id: Identity, reply: FastifyReply): Promise<boolean> {
    const enabled = rbacEnabled(id.workspaceId);
    const role = enabled ? await loadMemberRole(id.workspaceId, id.memberId) : null;
    const decision = decideApprovalClear({ rbacEnabled: enabled, role });
    if (decision.decision === "deny") {
      await reply.code(403).send({ error: decision.reason ?? "your role cannot clear approvals" });
      return false;
    }
    return true;
  }

  /** Run an approved request's executor as the requester; map failures onto the `failed` outcome. */
  async function execute(
    req: FastifyRequest,
    request: ApprovalRequest,
  ): Promise<ApprovalRequest> {
    return executeApprovedRequest(registry, request, req.log);
  }

  // --- policy rules (human admins manage what pauses) ---

  app.post("/workspaces/:wid/approval-policies", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!requireHuman(id, reply)) return;
    const b = req.body as { actionType?: string; requireApproval?: unknown; maxAutoAmount?: unknown };
    if (!b.actionType || typeof b.actionType !== "string") {
      return reply.code(400).send({ error: "actionType required" });
    }
    if (b.requireApproval !== undefined && typeof b.requireApproval !== "boolean") {
      return reply.code(400).send({ error: "requireApproval must be a boolean" });
    }
    let maxAutoAmount: number | null = null;
    if (b.maxAutoAmount !== undefined && b.maxAutoAmount !== null) {
      if (typeof b.maxAutoAmount !== "number" || !Number.isFinite(b.maxAutoAmount)) {
        return reply.code(400).send({ error: "maxAutoAmount must be a number" });
      }
      maxAutoAmount = b.maxAutoAmount;
    }
    const policy = await upsertPolicy({
      workspaceId: wid,
      actionType: b.actionType,
      requireApproval: b.requireApproval ?? true,
      maxAutoAmount,
      createdByMemberId: id.memberId,
    });
    return reply.code(201).send(policy);
  });

  app.get("/workspaces/:wid/approval-policies", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return listPolicies(wid);
  });

  app.delete("/workspaces/:wid/approval-policies/:ruleId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ruleId } = req.params as { wid: string; ruleId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!requireHuman(id, reply)) return;
    const ok = await deletePolicy(ruleId, wid);
    if (!ok) return reply.code(404).send({ error: "policy not found" });
    return { ok: true };
  });

  // --- submit an action (the gating seam) ---

  app.post("/workspaces/:wid/actions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as { actionType?: string; payload?: unknown; amount?: unknown; ttlSeconds?: unknown };

    if (!isActionType(b.actionType)) {
      return reply.code(400).send({ error: "unknown actionType" });
    }
    const executor = registry.get(b.actionType);
    if (!executor) return reply.code(400).send({ error: "unknown actionType" });
    const payload = (typeof b.payload === "object" && b.payload !== null ? b.payload : {}) as Record<
      string,
      unknown
    >;
    const valid = executor.validate(payload);
    if (!valid.ok) return reply.code(400).send({ error: valid.error });

    let amount: number | null = null;
    if (b.amount !== undefined && b.amount !== null) {
      if (typeof b.amount !== "number" || !Number.isFinite(b.amount)) {
        return reply.code(400).send({ error: "amount must be a number" });
      }
      amount = b.amount;
    }

    const rules = await listPolicyRules(wid);
    const decision = evaluatePolicy({ actionType: b.actionType, amount }, rules);
    const summary = executor.summarize(payload);

    if (!decision.requiresApproval) {
      // Auto-approved: execute immediately, but still record an auditable request (requested+executed).
      try {
        const result = await executor.execute(payload, {
          workspaceId: wid,
          requesterMemberId: id.memberId,
          log: req.log,
        });
        const request = await createRequest({
          workspaceId: wid,
          requesterMemberId: id.memberId,
          actionType: b.actionType,
          payload,
          amount,
          summary,
          status: "executed",
          expiresAt: null,
          result,
          events: [{ type: "requested", detail: { reason: decision.reason } }, { type: "executed", detail: result }],
        });
        return reply.code(200).send({ status: "executed", result, request });
      } catch (err) {
        const error = err instanceof ActionExecutionError ? err.message : "execution failed";
        if (!(err instanceof ActionExecutionError)) req.log.error({ err }, "auto-action failed");
        return reply.code(502).send({ status: "failed", error });
      }
    }

    // Gated: pause for a human. Create a pending request + notify the reviewers (#8 `approval`).
    const ttlSeconds =
      typeof b.ttlSeconds === "number" && Number.isFinite(b.ttlSeconds) && b.ttlSeconds >= 0
        ? b.ttlSeconds
        : loadEnv().approval.defaultTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const request = await createRequest({
      workspaceId: wid,
      requesterMemberId: id.memberId,
      actionType: b.actionType,
      payload,
      amount,
      summary,
      status: "pending",
      expiresAt,
      events: [{ type: "requested", detail: { reason: decision.reason } }],
    });

    // Best-effort: alert every other human member that a decision is needed (never fails the write).
    const reviewers = await listHumanReviewers(wid, id.memberId);
    for (const recipientMemberId of reviewers) {
      await notify(req.log, {
        workspaceId: wid,
        recipientMemberId,
        type: "approval",
        actorMemberId: id.memberId,
        excerpt: `Approval needed: ${summary}`,
      });
    }
    // #170: also DM the owner the Approve/Reject buttons in Slack, if connected (best-effort; the hook
    // is a no-op when no Slack bridge is registered, so the #13 gate is unchanged).
    await fireApprovalPending(req.log, request);
    // #370: if the requester is an agent in a department channel, it @mentions the owner in-channel so the
    // pending gate is visible in the coordination view (best-effort; no-op unless posting is enabled).
    if (id.kind === "agent") {
      const dept = departmentForHandle(id.displayName.toLowerCase());
      if (dept) {
        await coordinationBridge.post(wid, {
          kind: "approval_required",
          channel: dept.channel,
          agentHandle: id.displayName,
          approvalRequestId: request.id,
          summary,
        });
      }
    }
    return reply.code(202).send({ status: "pending", reason: decision.reason, request });
  });

  // --- review queue ---

  app.get("/workspaces/:wid/approvals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { status?: string };
    if (q.status && !isApprovalStatus(q.status)) {
      return reply.code(400).send({ error: "invalid status filter" });
    }
    const status = isApprovalStatus(q.status) ? q.status : undefined;
    const requests = await listRequests(wid, { status });
    // #322: collapse duplicate Spend-Approval deliverable drafts (the dozen near-identical "audit"
    // cards the duplicate-launch bug produced) to ONE card per real objective — but only for the
    // PENDING queue and only when dedup is enabled for this workspace (DEFAULT-OFF, owner-first). Other
    // statuses and non-deliverable approvals are returned untouched, so governance is never masked.
    if (status === "pending" && resolveDedupeEnabled(loadConfig(wid).marketing, wid)) {
      return collapseDuplicateDeliverables(requests);
    }
    return requests;
  });

  app.get("/approvals/:rid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { rid } = req.params as { rid: string };
    const request = await requireApprovalInWorkspace(id, rid, reply);
    if (!request) return;
    return request;
  });

  app.get("/approvals/:rid/events", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { rid } = req.params as { rid: string };
    const request = await requireApprovalInWorkspace(id, rid, reply);
    if (!request) return;
    return listRequestEvents(rid);
  });

  // --- decisions (humans only) ---

  app.post("/approvals/:rid/approve", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { rid } = req.params as { rid: string };
    const request = await requireApprovalInWorkspace(id, rid, reply);
    if (!request) return;
    if (!requireHuman(id, reply)) return;
    if (!(await requireCanClear(id, reply))) return;
    if (request.requesterMemberId === id.memberId) {
      return reply.code(403).send({ error: "cannot approve your own request" });
    }
    const reason = typeof (req.body as { reason?: unknown })?.reason === "string"
      ? (req.body as { reason: string }).reason
      : null;
    // #119: an optional edit to a drafted-content field — when present the executor runs the EDITED
    // draft and the decision is recorded as `edited` (with its Levenshtein distance) rather than
    // `approved`, the per-action correction signal the evidence pricer reads.
    const rawEdit = (req.body as { edit?: unknown })?.edit;
    const edit =
      rawEdit &&
      typeof rawEdit === "object" &&
      typeof (rawEdit as { field?: unknown }).field === "string" &&
      typeof (rawEdit as { value?: unknown }).value === "string"
        ? { field: (rawEdit as { field: string }).field, value: (rawEdit as { value: string }).value }
        : null;

    const decision = await approveAndLock(rid, id.workspaceId, id.memberId, reason, edit);
    if (decision.outcome === "conflict") {
      return reply.code(409).send({ error: "request already decided" });
    }
    if (decision.outcome === "expired") {
      return reply.code(409).send({ status: "expired", error: "request expired", request: decision.request });
    }
    // Won the lock → execute. Success → executed, executor failure → failed (502, still audited).
    const finished = await execute(req, decision.request);
    if (finished.status === "failed") {
      return reply.code(502).send({ status: "failed", error: finished.error, request: finished });
    }
    return reply.code(200).send({ status: "executed", result: finished.result, request: finished });
  });

  app.post("/approvals/:rid/reject", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { rid } = req.params as { rid: string };
    const request = await requireApprovalInWorkspace(id, rid, reply);
    if (!request) return;
    if (!requireHuman(id, reply)) return;
    if (!(await requireCanClear(id, reply))) return;
    const reason = typeof (req.body as { reason?: unknown })?.reason === "string"
      ? (req.body as { reason: string }).reason
      : null;

    const decision = await rejectRequest(rid, id.workspaceId, id.memberId, reason);
    if (decision.outcome === "conflict") {
      return reply.code(409).send({ error: "request already decided" });
    }
    if (decision.outcome === "expired") {
      return reply.code(409).send({ status: "expired", error: "request expired", request: decision.request });
    }
    return reply.code(200).send({ status: "rejected", request: decision.request });
  });

  app.post("/workspaces/:wid/approvals/sweep-expired", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!requireHuman(id, reply)) return;
    return { expired: await sweepExpired(wid) };
  });
}
