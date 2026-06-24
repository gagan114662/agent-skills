import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { ApprovalRequest } from "../../src/db/repositories/approvals.js";
import { broadcastApprovalCompletion } from "../../src/approvals/notifications.js";
import type { ApprovalCompletionOutcome } from "../../src/approvals/notifications.js";
import type { NotifyInput } from "../../src/notifications/service.js";

const request: ApprovalRequest = {
  id: "req-1",
  workspaceId: "ws-1",
  requesterMemberId: "agent-1",
  actionType: "chat.post_message",
  payload: {},
  amount: null,
  summary: "Post launch update",
  status: "executed",
  reason: null,
  decidedByMemberId: "owner-1",
  decidedAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: null,
  expiresAtTimezone: "UTC",
  result: null,
  error: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function logger(): FastifyBaseLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(function child() {
      return this;
    }),
    level: "info",
  } as unknown as FastifyBaseLogger;
}

async function run(outcome: ApprovalCompletionOutcome): Promise<NotifyInput[]> {
  const calls: NotifyInput[] = [];
  await broadcastApprovalCompletion(logger(), request, "owner-1", outcome, {
    listHumanReviewers: async () => ["human-2", "human-3"],
    notify: async (_log, input) => {
      calls.push(input);
      return null;
    },
    recordAsyncSideEffectFailure: vi.fn(),
  });
  return calls;
}

describe("broadcastApprovalCompletion (#932)", () => {
  it.each([
    ["executed", "Approval completed: Post launch update"],
    ["failed", "Approval failed: Post launch update"],
    ["rejected", "Approval rejected: Post launch update"],
  ] as const)("broadcasts %s approval events to the other human reviewers", async (outcome, excerpt) => {
    const calls = await run(outcome);

    expect(calls).toEqual([
      {
        workspaceId: "ws-1",
        recipientMemberId: "human-2",
        type: "approval",
        actorMemberId: "owner-1",
        excerpt,
      },
      {
        workspaceId: "ws-1",
        recipientMemberId: "human-3",
        type: "approval",
        actorMemberId: "owner-1",
        excerpt,
      },
    ]);
  });

  it("records notification fan-out failures without throwing after the decision write", async () => {
    const log = logger();
    const recordAsyncSideEffectFailure = vi.fn();

    await expect(
      broadcastApprovalCompletion(log, request, "owner-1", "failed", {
        listHumanReviewers: async () => ["human-2"],
        notify: async () => {
          throw new Error("redis down");
        },
        recordAsyncSideEffectFailure,
      }),
    ).resolves.toBeUndefined();

    expect(recordAsyncSideEffectFailure).toHaveBeenCalledWith("approval_completion_notification");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        approvalRequestId: "req-1",
        recipientMemberId: "human-2",
        outcome: "failed",
      }),
      "approval completion notification failed after durable decision write",
    );
  });
});
