import type { FastifyInstance } from "fastify";
import { assertWorkspace, requireIdentity } from "../auth/guard.js";
import {
  getDeliverablePerformance,
  getDeliveryReceipt,
  listDeliveryReceipts,
  recordDeliverableFeedback,
  type DeliverableFeedbackCategory,
  type DeliveryReceiptRow,
} from "../db/repositories/delivery.js";
import { getAgentSessionById } from "../db/repositories/agent-sessions.js";
import { dbWorkspacePlanStore } from "../db/repositories/plans.js";
import { DELIVERABLE_FEEDBACK_CATEGORIES } from "../db/schema/index.js";
import type { ActivePlan } from "../billing/plan-service.js";

/**
 * Customer deliverables (#915): authenticated customers can see what shipped, where it lives, which
 * agent/session produced it, and whether the workspace is still trial/converted/past-due. Feedback writes
 * are workspace-scoped here; the legacy receipt-id feedback route stays for link-based prompts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 100;
const MAX_COMMENT_CHARS = 1_000;

interface DeliverableDto {
  id: string;
  approvalRequestId: string;
  sessionId: string | null;
  channel: string;
  reversibility: string;
  provider: string;
  live: boolean;
  externalRef: string | null;
  status: string;
  shippedAt: string;
  computeSeconds: number;
  estimatedCostCents: number;
  detail: Record<string, unknown>;
  feedbackUrl: string;
  agentActivity: {
    sessionId: string | null;
    agentMemberId: string | null;
    channelId: string | null;
    status: string | null;
    agentStatus: string | null;
    lastActivityAt: string | null;
  };
  performance: {
    views: number;
    engagements: number;
    conversions: number;
    engagementRate: number | null;
    conversionRate: number | null;
    latestMeasuredAt: string | null;
  };
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : 50;
  return Number.isInteger(n) ? Math.max(1, Math.min(MAX_LIMIT, n)) : 50;
}

function feedbackCategory(value: unknown): DeliverableFeedbackCategory | null {
  return typeof value === "string" &&
    (DELIVERABLE_FEEDBACK_CATEGORIES as readonly string[]).includes(value)
    ? (value as DeliverableFeedbackCategory)
    : null;
}

function parseRating(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function cleanComment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return trimmed ? trimmed.slice(0, MAX_COMMENT_CHARS) : null;
}

function planStatus(plan: ActivePlan | undefined): {
  planKey: string | null;
  status: "trial" | "active" | "past_due" | "expired" | "canceled";
  converted: boolean;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
} {
  if (!plan) {
    return {
      planKey: null,
      status: "trial",
      converted: false,
      trialEndsAt: null,
      currentPeriodEndsAt: null,
    };
  }
  const expired = plan.renewalStatus === "expired" || plan.status === "canceled";
  return {
    planKey: plan.planKey,
    status: expired ? "expired" : plan.renewalStatus === "canceled" ? "canceled" : plan.renewalStatus,
    converted: plan.status === "active" && !expired,
    trialEndsAt: null,
    currentPeriodEndsAt: plan.expiresAt.toISOString(),
  };
}

async function receiptDto(workspaceId: string, receipt: DeliveryReceiptRow): Promise<DeliverableDto> {
  const [session, performance] = await Promise.all([
    receipt.sessionId ? getAgentSessionById(receipt.sessionId) : Promise.resolve(undefined),
    getDeliverablePerformance(workspaceId, receipt.id),
  ]);
  const tenantSession = session?.workspaceId === workspaceId ? session : undefined;
  const latest = performance?.latest ?? null;
  return {
    id: receipt.id,
    approvalRequestId: receipt.approvalRequestId,
    sessionId: receipt.sessionId,
    channel: receipt.channel,
    reversibility: receipt.reversibility,
    provider: receipt.provider,
    live: receipt.live,
    externalRef: receipt.externalRef,
    status: receipt.status,
    shippedAt: new Date(receipt.shippedAtMs).toISOString(),
    computeSeconds: receipt.computeSeconds,
    estimatedCostCents: receipt.estimatedCostCents,
    detail: receipt.detail,
    feedbackUrl: `/me/deliverables/${receipt.id}/feedback`,
    agentActivity: {
      sessionId: receipt.sessionId,
      agentMemberId: tenantSession?.agentMemberId ?? null,
      channelId: tenantSession?.channelId ?? null,
      status: tenantSession?.status ?? null,
      agentStatus: tenantSession?.agentStatus ?? null,
      lastActivityAt:
        tenantSession?.endedAt?.toISOString() ??
        tenantSession?.lastHeartbeatAt?.toISOString() ??
        tenantSession?.startedAt?.toISOString() ??
        tenantSession?.createdAt?.toISOString() ??
        null,
    },
    performance: {
      views: performance?.totals.views ?? 0,
      engagements: performance?.totals.engagements ?? 0,
      conversions: performance?.totals.conversions ?? 0,
      engagementRate: performance?.totals.engagementRate ?? null,
      conversionRate: performance?.totals.conversionRate ?? null,
      latestMeasuredAt: latest ? new Date(latest.measuredAtMs).toISOString() : null,
    },
  };
}

async function listForWorkspace(workspaceId: string, limit: number): Promise<{
  deliverables: DeliverableDto[];
  trial: ReturnType<typeof planStatus>;
}> {
  const [receipts, plan] = await Promise.all([
    listDeliveryReceipts(workspaceId, limit),
    dbWorkspacePlanStore.getActive(workspaceId),
  ]);
  return {
    deliverables: await Promise.all(receipts.map((receipt) => receiptDto(workspaceId, receipt))),
    trial: planStatus(plan),
  };
}

export async function customerDeliverableRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/deliverables", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const query = req.query as { limit?: unknown };
    return listForWorkspace(id.workspaceId, parseLimit(query.limit));
  });

  app.get("/workspaces/:wid/deliverables", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { limit?: unknown };
    return listForWorkspace(wid, parseLimit(query.limit));
  });

  app.post("/me/deliverables/:receiptId/feedback", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { receiptId } = req.params as { receiptId: string };
    if (!UUID_RE.test(receiptId)) return reply.code(400).send({ error: "invalid receipt id" });
    const receipt = await getDeliveryReceipt(id.workspaceId, receiptId);
    if (!receipt) {
      return reply.code(404).send({ error: "delivery receipt not found" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rating = parseRating(body.rating);
    if (rating === null) return reply.code(400).send({ error: "rating must be an integer from 1 to 5" });
    const category = body.category === undefined ? "other" : feedbackCategory(body.category);
    if (!category) return reply.code(400).send({ error: "invalid feedback category" });
    const recorded = await recordDeliverableFeedback({
      deliveryReceiptId: receiptId,
      rating,
      category,
      comment: cleanComment(body.comment),
    });
    if (!recorded || recorded.feedback.workspaceId !== id.workspaceId) {
      return reply.code(404).send({ error: "delivery receipt not found" });
    }
    return reply.code(202).send({ feedback: recorded.feedback });
  });
}
