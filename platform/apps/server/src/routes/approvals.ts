import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { Identity } from "../auth/identity.js";
import { getChannel } from "../db/repositories/channels.js";
import {
  getApprovalRequest,
  getGovernancePolicy,
  listApprovalRequests,
  upsertGovernancePolicy,
} from "../db/repositories/approvals.js";
import {
  isActionKind,
  isApprovalStatus,
  type ApprovalStatus,
  type GovernancePolicy,
  type SensitiveAction,
} from "../governance/policy.js";
import type { ApprovalServiceFactory, ResolveResult } from "../governance/service.js";
import { createDefaultApprovalService } from "../governance/default.js";

/**
 * Human approval gates & governance (issue #13, ADR-0013). Agents (or members) request a sensitive
 * action; the policy engine decides whether a human must approve; humans approve (→ execute) or
 * reject (→ block). Every request + decision is an audit row, queryable per workspace.
 *
 * All routes are workspace-scoped (#3 IDOR via {@link assertWorkspace}). Deciding an approval and
 * writing the policy are **human-only** (`identity.kind === "human"`) — the reload "humans on
 * critical decisions" rule and the core no-bypass governance guard.
 */
export interface ApprovalRoutesOptions {
  /** Build the service for a request (tests may inject a fake-seam factory). */
  serviceFactory?: ApprovalServiceFactory;
}

/** Reject non-human callers from a governance decision. Returns true when the caller is human. */
function requireHuman(id: Identity, reply: FastifyReply): boolean {
  if (id.kind !== "human") {
    void reply.code(403).send({ error: "human approval required" });
    return false;
  }
  return true;
}

export async function approvalRoutes(
  app: FastifyInstance,
  opts: ApprovalRoutesOptions = {},
): Promise<void> {
  const makeService = opts.serviceFactory ?? createDefaultApprovalService;

  // Request approval for a sensitive action. Any member may request; the policy decides whether it
  // pends for a human or auto-approves + executes. Returns the persisted (audit) request.
  app.post("/workspaces/:wid/approvals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const b = req.body as {
      actionKind?: unknown;
      summary?: unknown;
      amountCents?: unknown;
      currency?: unknown;
      channelId?: unknown;
      destination?: unknown;
      metadata?: unknown;
    };

    if (!isActionKind(b.actionKind)) {
      return reply.code(400).send({ error: "actionKind must be one of external_send|spend|channel_post|custom" });
    }
    if (typeof b.summary !== "string" || b.summary.trim().length === 0) {
      return reply.code(400).send({ error: "summary required" });
    }
    const action: SensitiveAction = { kind: b.actionKind, summary: b.summary };

    if (b.amountCents !== undefined) {
      if (typeof b.amountCents !== "number" || !Number.isFinite(b.amountCents) || b.amountCents < 0) {
        return reply.code(400).send({ error: "amountCents must be a non-negative number" });
      }
      action.amountCents = b.amountCents;
    }
    if (b.currency !== undefined) {
      if (typeof b.currency !== "string") return reply.code(400).send({ error: "currency must be a string" });
      action.currency = b.currency;
    }
    if (b.destination !== undefined) {
      if (typeof b.destination !== "string") {
        return reply.code(400).send({ error: "destination must be a string" });
      }
      action.destination = b.destination;
    }
    if (b.metadata !== undefined) {
      if (typeof b.metadata !== "object" || b.metadata === null || Array.isArray(b.metadata)) {
        return reply.code(400).send({ error: "metadata must be an object" });
      }
      action.metadata = b.metadata as Record<string, unknown>;
    }
    if (b.channelId !== undefined) {
      if (typeof b.channelId !== "string") return reply.code(400).send({ error: "channelId must be a string" });
      // IDOR: a channel id must belong to the caller's workspace before we record/post into it.
      const ch = await getChannel(b.channelId);
      if (!ch || ch.workspaceId !== wid) {
        return reply.code(404).send({ error: "channel not found in this workspace" });
      }
      action.channelId = b.channelId;
    }

    const service = makeService(req.log);
    const request = await service.request({
      workspaceId: wid,
      requestedByMemberId: id.memberId,
      action,
    });
    return reply.code(201).send(request);
  });

  // Audit list: a workspace's approval requests, newest first. ?status= / ?requestedBy= filter.
  app.get("/workspaces/:wid/approvals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { status?: string; requestedBy?: string };
    if (q.status !== undefined && !isApprovalStatus(q.status)) {
      return reply.code(400).send({ error: "invalid status filter" });
    }
    return listApprovalRequests(wid, {
      status: q.status as ApprovalStatus | undefined,
      requestedByMemberId: q.requestedBy,
    });
  });

  // One request + its decision (the preview a human reviews; also an audit read).
  app.get("/workspaces/:wid/approvals/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: rid } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const request = await getApprovalRequest(rid, wid);
    if (!request) return reply.code(404).send({ error: "approval request not found" });
    return request;
  });

  // Approve a pending request → execute the action. Human-only.
  app.post("/workspaces/:wid/approvals/:id/approve", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: rid } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!requireHuman(id, reply)) return;
    const b = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof b.reason === "string" ? b.reason : undefined;

    const service = makeService(req.log);
    const res = await service.approve(rid, wid, id.memberId, reason);
    return sendResolveResult(res, reply);
  });

  // Reject a pending request → block the action. Human-only; a reason is required.
  app.post("/workspaces/:wid/approvals/:id/reject", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: rid } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!requireHuman(id, reply)) return;
    const b = (req.body ?? {}) as { reason?: unknown };
    if (typeof b.reason !== "string" || b.reason.trim().length === 0) {
      return reply.code(400).send({ error: "reason required to reject" });
    }

    const service = makeService(req.log);
    const res = await service.reject(rid, wid, id.memberId, b.reason);
    return sendResolveResult(res, reply);
  });

  // Read the workspace governance policy (defaults when unset). Any member may read.
  app.get("/workspaces/:wid/governance-policy", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return getGovernancePolicy(wid);
  });

  // Upsert the workspace governance policy (partial patch). Human-only.
  app.put("/workspaces/:wid/governance-policy", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!requireHuman(id, reply)) return;

    const patch = parsePolicyPatch(req.body, reply);
    if (patch === null) return; // validation response already sent
    return upsertGovernancePolicy(wid, patch);
  });
}

/** Map a service ResolveResult onto an HTTP response. */
function sendResolveResult(res: ResolveResult, reply: FastifyReply): FastifyReply {
  if (res.ok) return reply.send(res.request);
  switch (res.code) {
    case "not_found":
      return reply.code(404).send({ error: "approval request not found" });
    case "expired":
      return reply.code(409).send({ error: "approval request has expired" });
    case "already_decided":
      return reply.code(409).send({ error: "approval request already decided" });
  }
}

/** Validate + build a governance-policy patch from a request body, or send 400 and return null. */
function parsePolicyPatch(
  body: unknown,
  reply: FastifyReply,
): Partial<GovernancePolicy> | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<GovernancePolicy> = {};

  if ("spendThresholdCents" in b) {
    const v = b.spendThresholdCents;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      reply.code(400).send({ error: "spendThresholdCents must be a non-negative number" });
      return null;
    }
    patch.spendThresholdCents = v;
  }
  if ("externalSendRequiresApproval" in b) {
    if (typeof b.externalSendRequiresApproval !== "boolean") {
      reply.code(400).send({ error: "externalSendRequiresApproval must be a boolean" });
      return null;
    }
    patch.externalSendRequiresApproval = b.externalSendRequiresApproval;
  }
  if ("requireApprovalFor" in b) {
    const v = b.requireApprovalFor;
    if (!Array.isArray(v) || !v.every((k) => isActionKind(k))) {
      reply.code(400).send({ error: "requireApprovalFor must be an array of action kinds" });
      return null;
    }
    patch.requireApprovalFor = v as GovernancePolicy["requireApprovalFor"];
  }
  if ("guardedChannelIds" in b) {
    const v = b.guardedChannelIds;
    if (!Array.isArray(v) || !v.every((c) => typeof c === "string")) {
      reply.code(400).send({ error: "guardedChannelIds must be an array of channel ids" });
      return null;
    }
    patch.guardedChannelIds = v as string[];
  }
  if ("defaultTtlMs" in b) {
    const v = b.defaultTtlMs;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      reply.code(400).send({ error: "defaultTtlMs must be a positive number" });
      return null;
    }
    patch.defaultTtlMs = v;
  }
  return patch;
}
