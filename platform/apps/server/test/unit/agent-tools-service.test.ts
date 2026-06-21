import { describe, it, expect, beforeEach } from "vitest";
import {
  ExecutionToolService,
  type ExecutionApprovalGate,
  type ExecutionAuditEntry,
  type ExecutionAuditSink,
} from "../../src/agent-tools/service.js";
import { EXECUTION_TOOLS } from "../../src/agent-tools/registry.js";

/** A fake #13 gate that records every parked request and never executes anything. */
class FakeGate implements ExecutionApprovalGate {
  readonly parked: Array<{
    workspaceId: string;
    actionType: string;
    summary: string;
    payload: Record<string, unknown>;
    amount: number | null;
  }> = [];
  private seq = 0;
  async park(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionType: string;
    summary: string;
    payload: Record<string, unknown>;
    amount: number | null;
  }): Promise<{ id: string }> {
    this.parked.push({
      workspaceId: input.workspaceId,
      actionType: input.actionType,
      summary: input.summary,
      payload: input.payload,
      amount: input.amount,
    });
    return { id: `req-${++this.seq}` };
  }
}

class FakeAudit implements ExecutionAuditSink {
  readonly entries: ExecutionAuditEntry[] = [];
  async record(entry: ExecutionAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function makeService(opts?: { enabled?: boolean }) {
  const gate = new FakeGate();
  const audit = new FakeAudit();
  const service = new ExecutionToolService({
    registry: EXECUTION_TOOLS,
    flags: () => ({ enabled: opts?.enabled ?? true }),
    approvals: gate,
    audit,
    now: () => new Date("2026-06-21T00:00:00.000Z"),
  });
  return { service, gate, audit };
}

const ctx = { workspaceId: "ws-1", requesterMemberId: "mem-7" };

describe("ExecutionToolService.invoke — the human-approval boundary", () => {
  let s: ReturnType<typeof makeService>;
  beforeEach(() => {
    s = makeService();
  });

  it("parks a PENDING #13 approval for a publish and NEVER executes it (only fires after approval)", async () => {
    const res = await s.service.invoke({
      ...ctx,
      toolName: "content.publish",
      args: { title: "Launch", slug: "launch" },
    });
    expect(res.status).toBe("pending_approval");
    if (res.status !== "pending_approval") return;
    expect(res.approvalRequestId).toBe("req-1");
    expect(res.gatedAction).toBe("hosted.publish");
    // Exactly one request parked; it carries routing-only payload, no autonomous execution happened.
    expect(s.gate.parked).toHaveLength(1);
    expect(s.gate.parked[0].actionType).toBe("hosted.publish");
    expect(s.gate.parked[0].payload).not.toHaveProperty("title");
    expect(s.gate.parked[0].payload).toMatchObject({ slug: "launch" });
  });

  it("records every invocation in the audit log with its boundary and approval id", async () => {
    await s.service.invoke({ ...ctx, toolName: "social.post", args: { postId: "p1", networks: ["x"] } });
    expect(s.audit.entries).toHaveLength(1);
    const e = s.audit.entries[0];
    expect(e).toMatchObject({
      workspaceId: "ws-1",
      requesterMemberId: "mem-7",
      toolName: "social.post",
      gatedAction: "social.publish_post",
      visibility: "outbound",
      outcome: "pending_approval",
      approvalRequestId: "req-1",
    });
    expect(e.at.toISOString()).toBe("2026-06-21T00:00:00.000Z");
  });

  it("carries the spend amount onto the parked money request so the owner sees the exact budget", async () => {
    const res = await s.service.invoke({
      ...ctx,
      toolName: "ads.launch_campaign",
      args: { campaignId: "c9", dailyBudget: 300 },
    });
    expect(res.status).toBe("pending_approval");
    expect(s.gate.parked[0].amount).toBe(300);
    expect(s.gate.parked[0].actionType).toBe("venture.ad_spend");
  });

  it("rejects an unknown tool without parking or executing anything (fail-closed)", async () => {
    const res = await s.service.invoke({ ...ctx, toolName: "delete.everything", args: {} });
    expect(res.status).toBe("unknown_tool");
    expect(s.gate.parked).toHaveLength(0);
    expect(s.audit.entries[0].outcome).toBe("unknown_tool");
  });

  it("rejects invalid args (validation) without parking", async () => {
    const res = await s.service.invoke({ ...ctx, toolName: "content.publish", args: { title: "x" } });
    expect(res.status).toBe("rejected");
    expect(s.gate.parked).toHaveLength(0);
    expect(s.audit.entries[0].outcome).toBe("rejected");
  });

  it("refuses to invoke when execution tools are disabled for the workspace", async () => {
    const off = makeService({ enabled: false });
    const res = await off.service.invoke({
      ...ctx,
      toolName: "content.publish",
      args: { title: "Launch", slug: "launch" },
    });
    expect(res.status).toBe("disabled");
    expect(off.gate.parked).toHaveLength(0);
  });

  it("lists the execution tools an agent department carries (runtime advertisement)", () => {
    expect(s.service.listTools("content").map((t) => t.name)).toEqual(["content.publish"]);
    expect(s.service.listTools().length).toBe(EXECUTION_TOOLS.length);
  });
});
