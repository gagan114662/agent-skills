import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { ActionExecutor } from "../../src/approvals/executor.js";
import type { ApprovalRequest } from "../../src/db/repositories/approvals.js";

const repo = vi.hoisted(() => ({
  getRequest: vi.fn(),
  recordExecution: vi.fn(),
}));

vi.mock("../../src/db/repositories/approvals.js", () => repo);

import { executeApprovedRequest } from "../../src/approvals/execute.js";

const log = {
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function request(status: ApprovalRequest["status"]): ApprovalRequest {
  return {
    id: "00000000-0000-4000-8000-000000000966",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    requesterMemberId: "00000000-0000-4000-8000-000000000002",
    actionType: "chat.post_message",
    payload: { channelId: "c-1", body: "ship it" },
    amount: null,
    summary: "post a message",
    status,
    reason: null,
    decidedByMemberId: null,
    decidedAt: null,
    expiresAt: null,
    result: null,
    error: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("#966 executeApprovedRequest idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns conflict and does not invoke the executor when the request is already executed", async () => {
    const staleApproved = request("approved");
    const alreadyExecuted = request("executed");
    repo.getRequest.mockResolvedValue(alreadyExecuted);
    const execute = vi.fn(async () => ({ messageId: "m-1" }));
    const executor: ActionExecutor = {
      actionType: "chat.post_message",
      validate: () => ({ ok: true }),
      summarize: () => "post a message",
      execute,
    };

    const result = await executeApprovedRequest(new Map([[executor.actionType, executor]]), staleApproved, log);

    expect(result).toEqual({ outcome: "conflict", request: alreadyExecuted });
    expect(execute).not.toHaveBeenCalled();
    expect(repo.recordExecution).not.toHaveBeenCalled();
  });
});
