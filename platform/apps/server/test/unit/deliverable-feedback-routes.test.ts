import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const recordDeliverableFeedback = vi.fn();
const summarizeDeliverableFeedback = vi.fn();
const markDeliverableFeedbackAlerted = vi.fn(async () => undefined);
const getWorkspaceOwnerMemberId = vi.fn(async () => "member-owner");
const notify = vi.fn(async () => ({ id: "notif-1" }));

vi.mock("../../src/db/repositories/delivery.js", () => ({
  DELIVERABLE_FEEDBACK_CATEGORIES: ["helpful", "off_brand", "inaccurate", "unclear", "other"],
  recordDeliverableFeedback,
  summarizeDeliverableFeedback,
  markDeliverableFeedbackAlerted,
}));
vi.mock("../../src/db/repositories/members.js", () => ({ getWorkspaceOwnerMemberId }));
vi.mock("../../src/notifications/service.js", () => ({ notify }));
vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async () => ({ workspaceId: "workspace-1", memberId: "member-1" })),
  assertWorkspace: vi.fn(
    (
      identity: { workspaceId: string },
      workspaceId: string,
      reply: { code: (n: number) => { send: (b: unknown) => void } },
    ) => {
      if (identity.workspaceId === workspaceId) return true;
      reply.code(403).send({ error: "wrong workspace" });
      return false;
    },
  ),
}));

const { deliverableFeedbackRoutes } = await import("../../src/routes/deliverable-feedback.js");

const RECEIPT_ID = "11111111-2222-3333-4444-555555555555";

async function buildApp() {
  const app = Fastify();
  await app.register(deliverableFeedbackRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  recordDeliverableFeedback.mockReset();
  summarizeDeliverableFeedback.mockReset();
  markDeliverableFeedbackAlerted.mockClear();
  getWorkspaceOwnerMemberId.mockClear();
  notify.mockClear();
});

describe("deliverable feedback routes (#870)", () => {
  it("records receipt-linked feedback and proactively alerts the owner on low ratings", async () => {
    recordDeliverableFeedback.mockResolvedValue({
      feedback: {
        id: "feedback-1",
        workspaceId: "workspace-1",
        deliveryReceiptId: RECEIPT_ID,
        rating: 1,
        category: "off_brand",
        comment: "This missed our tone.",
        alertNotifiedAtMs: null,
        createdAtMs: 1_234,
      },
      receipt: {
        id: RECEIPT_ID,
        approvalRequestId: "approval-1",
        sessionId: "session-1",
        channel: "publish",
        reversibility: "reversible",
        provider: "github_pages",
        live: true,
        externalRef: "https://example.com/post",
        status: "shipped",
        shippedAtMs: 1_000,
      },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/delivery/receipts/${RECEIPT_ID}/feedback`,
      payload: { rating: 1, category: "off_brand", comment: "This missed\nour tone." },
    });

    expect(res.statusCode).toBe(202);
    expect(recordDeliverableFeedback).toHaveBeenCalledWith({
      deliveryReceiptId: RECEIPT_ID,
      rating: 1,
      category: "off_brand",
      comment: "This missed our tone.",
    });
    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: "workspace-1",
        recipientMemberId: "member-owner",
        type: "deliverable_feedback",
        excerpt: expect.stringContaining("1/5 off_brand"),
      }),
    );
    expect(markDeliverableFeedbackAlerted).toHaveBeenCalledWith("feedback-1");
    await app.close();
  });

  it("exposes a founder summary without requiring support complaints", async () => {
    summarizeDeliverableFeedback.mockResolvedValue({
      count: 3,
      averageRating: 3.7,
      lowRatingCount: 1,
      latestLowRating: { id: "feedback-1", rating: 2 },
    });
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/me/deliverable-feedback/summary" });

    expect(res.statusCode).toBe(200);
    expect(summarizeDeliverableFeedback).toHaveBeenCalledWith("workspace-1");
    expect(res.json()).toMatchObject({ summary: { count: 3, averageRating: 3.7, lowRatingCount: 1 } });
    await app.close();
  });

  it("rejects invalid ratings before writing feedback", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/delivery/receipts/${RECEIPT_ID}/feedback`,
      payload: { rating: 6, category: "helpful" },
    });

    expect(res.statusCode).toBe(400);
    expect(recordDeliverableFeedback).not.toHaveBeenCalled();
    await app.close();
  });
});
