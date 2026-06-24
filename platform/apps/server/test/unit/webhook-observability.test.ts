import { describe, expect, it, beforeEach } from "vitest";
import {
  recordWebhookSignatureFailure,
  renderMetrics,
  resetMetrics,
} from "../../src/observability/metrics.js";
import { approvalDecisionLog } from "../../src/routes/approvals.js";
import type { ApprovalRequest } from "../../src/db/repositories/approvals.js";

describe("webhook signature observability (#999)", () => {
  beforeEach(() => resetMetrics());

  it("counts signature failures by bounded provider and reason labels", () => {
    recordWebhookSignatureFailure("stripe", "timestamp outside tolerance");
    recordWebhookSignatureFailure("stripe", "timestamp outside tolerance");

    expect(renderMetrics()).toContain(
      'webhook_signature_failures_total{provider="stripe",reason="timestamp outside tolerance"} 2',
    );
  });
});

describe("approval decision log payloads (#997)", () => {
  it("captures the compliance fields needed before execution starts", () => {
    const request: ApprovalRequest = {
      id: "apr_1",
      workspaceId: "ws_1",
      requesterMemberId: "agent_1",
      actionType: "outreach.send",
      payload: {},
      amount: 1200,
      summary: "Send campaign",
      status: "approved",
      reason: "looks good",
      result: null,
      error: null,
      expiresAt: null,
      decidedByMemberId: "human_1",
      decidedAt: new Date("2026-06-24T10:00:00.000Z"),
      createdAt: new Date("2026-06-24T09:55:00.000Z"),
      updatedAt: new Date("2026-06-24T10:00:00.000Z"),
    };

    expect(approvalDecisionLog(request, "approved")).toEqual({
      requestId: "apr_1",
      workspaceId: "ws_1",
      requesterMemberId: "agent_1",
      decidedByMemberId: "human_1",
      actionType: "outreach.send",
      amount: 1200,
      summary: "Send campaign",
      outcome: "approved",
      reason: "looks good",
      edited: false,
    });
  });
});
