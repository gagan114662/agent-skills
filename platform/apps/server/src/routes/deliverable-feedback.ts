import type { FastifyInstance, FastifyRequest } from "fastify";
import { assertWorkspace, requireIdentity } from "../auth/guard.js";
import {
  markDeliverableFeedbackAlerted,
  recordDeliverableFeedback,
  summarizeDeliverableFeedback,
  type DeliverableFeedbackCategory,
} from "../db/repositories/delivery.js";
import { DELIVERABLE_FEEDBACK_CATEGORIES } from "../db/schema/index.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { notify } from "../notifications/service.js";
import { recordAsyncSideEffectFailure } from "../observability/metrics.js";

/**
 * Proactive deliverable feedback (#870): customers can rate a shipped receipt directly, and owners get an
 * immediate notification on low ratings instead of discovering quality problems only through churn/support.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOW_RATING_THRESHOLD = 2;
const MAX_COMMENT_CHARS = 1_000;

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

async function notifyLowRating(
  app: FastifyInstance,
  req: FastifyRequest,
  input: {
    workspaceId: string;
    feedbackId: string;
    receiptId: string;
    rating: number;
    category: string;
    comment: string | null;
    externalRef: string | null;
  },
): Promise<void> {
  try {
    const ownerMemberId = await getWorkspaceOwnerMemberId(input.workspaceId);
    if (!ownerMemberId) return;
    const where = input.externalRef ? ` (${input.externalRef})` : "";
    const comment = input.comment ? `: ${input.comment}` : "";
    await notify(app.log, {
      workspaceId: input.workspaceId,
      recipientMemberId: ownerMemberId,
      type: "deliverable_feedback",
      excerpt: `Low deliverable feedback: ${input.rating}/5 ${input.category} on receipt ${input.receiptId}${where}${comment}`,
    });
    await markDeliverableFeedbackAlerted(input.feedbackId);
  } catch (err) {
    recordAsyncSideEffectFailure("deliverable_feedback_low_rating_notification");
    req.log.error(
      { err, workspaceId: input.workspaceId, feedbackId: input.feedbackId },
      "deliverable feedback alert failed",
    );
  }
}

export async function deliverableFeedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post("/delivery/receipts/:receiptId/feedback", async (req, reply) => {
    const { receiptId } = req.params as { receiptId: string };
    if (!UUID_RE.test(receiptId)) return reply.code(400).send({ error: "invalid receipt id" });
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
    if (!recorded) return reply.code(404).send({ error: "delivery receipt not found" });

    if (recorded.feedback.rating <= LOW_RATING_THRESHOLD) {
      await notifyLowRating(app, req, {
        workspaceId: recorded.feedback.workspaceId,
        feedbackId: recorded.feedback.id,
        receiptId,
        rating: recorded.feedback.rating,
        category: recorded.feedback.category,
        comment: recorded.feedback.comment,
        externalRef: recorded.receipt.externalRef,
      });
    }

    return reply.code(202).send({ feedback: recorded.feedback });
  });

  app.get("/me/deliverable-feedback/summary", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return { summary: await summarizeDeliverableFeedback(id.workspaceId) };
  });

  app.get("/workspaces/:wid/deliverable-feedback/summary", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return { summary: await summarizeDeliverableFeedback(wid) };
  });
}
