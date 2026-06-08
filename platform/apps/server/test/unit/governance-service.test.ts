import { describe, it, expect, beforeEach, vi } from "vitest";
import { ApprovalService, type ApprovalStore } from "../../src/governance/service.js";
import { DEFAULT_POLICY, type GovernancePolicy } from "../../src/governance/policy.js";
import type { ApprovalRequest } from "../../src/db/repositories/approvals.js";

/** Minimal in-memory store so the service is exercised with no DB. */
class FakeStore implements ApprovalStore {
  rows = new Map<string, ApprovalRequest>();
  policy: GovernancePolicy = DEFAULT_POLICY;
  private seq = 0;

  async create(input: Parameters<ApprovalStore["create"]>[0]): Promise<ApprovalRequest> {
    const id = `req-${++this.seq}`;
    const row: ApprovalRequest = {
      id,
      workspaceId: input.workspaceId,
      requestedByMemberId: input.requestedByMemberId,
      actionKind: input.actionKind,
      actionSummary: input.actionSummary,
      action: input.action,
      channelId: input.channelId ?? null,
      status: input.status,
      policyReason: input.policyReason,
      decidedByMemberId: null,
      decisionReason: null,
      outcome: null,
      createdAt: new Date("2026-06-08T00:00:00Z"),
      decidedAt: null,
      executedAt: null,
      expiresAt: input.expiresAt ?? null,
    };
    this.rows.set(id, row);
    return { ...row };
  }
  async getById(id: string, workspaceId: string): Promise<ApprovalRequest | undefined> {
    const r = this.rows.get(id);
    return r && r.workspaceId === workspaceId ? { ...r } : undefined;
  }
  async resolvePending(
    id: string,
    workspaceId: string,
    fields: Parameters<ApprovalStore["resolvePending"]>[2],
  ): Promise<ApprovalRequest | undefined> {
    const r = this.rows.get(id);
    if (!r || r.workspaceId !== workspaceId || r.status !== "pending") return undefined;
    r.status = fields.status;
    r.decidedByMemberId = fields.decidedByMemberId ?? null;
    r.decisionReason = fields.decisionReason ?? null;
    r.decidedAt = fields.decidedAt;
    return { ...r };
  }
  async recordExecution(id: string, _ws: string, outcome: string, executedAt: Date): Promise<void> {
    const r = this.rows.get(id);
    if (r) {
      r.outcome = outcome;
      r.executedAt = executedAt;
    }
  }
  async getPolicy(): Promise<GovernancePolicy> {
    return this.policy;
  }
}

const WS = "ws-1";
const REQUESTER = "agent-1";
const APPROVER = "human-1";

function makeService(store: FakeStore, now = new Date("2026-06-08T00:00:00Z")) {
  const executor = { execute: vi.fn(async () => ({ outcome: "posted message msg-1" })) };
  const notifier = { notifyPending: vi.fn(async () => {}) };
  const service = new ApprovalService({ store, executor, notifier, clock: { now: () => now } });
  return { service, executor, notifier };
}

describe("ApprovalService (#13)", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it("auto-approves and executes an action the policy does not gate", async () => {
    const { service, executor, notifier } = makeService(store);
    const req = await service.request({
      workspaceId: WS,
      requestedByMemberId: REQUESTER,
      action: { kind: "custom", summary: "rename a label" },
    });
    expect(req.status).toBe("auto_approved");
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPending).not.toHaveBeenCalled();
    expect(req.outcome).toBe("posted message msg-1");
    expect(req.executedAt).not.toBeNull();
  });

  it("pends a sensitive action without executing it, and notifies", async () => {
    const { service, executor, notifier } = makeService(store);
    const req = await service.request({
      workspaceId: WS,
      requestedByMemberId: REQUESTER,
      action: { kind: "external_send", summary: "email the quarterly report" },
    });
    expect(req.status).toBe("pending");
    expect(req.expiresAt).not.toBeNull();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(notifier.notifyPending).toHaveBeenCalledTimes(1);
  });

  it("approve executes the gated action exactly once and records who decided", async () => {
    const { service, executor } = makeService(store);
    const pending = await service.request({
      workspaceId: WS,
      requestedByMemberId: REQUESTER,
      action: { kind: "external_send", summary: "send it" },
    });
    const res = await service.approve(pending.id, WS, APPROVER, "looks good");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.request.status).toBe("approved");
    expect(res.request.decidedByMemberId).toBe(APPROVER);
    expect(res.request.decisionReason).toBe("looks good");
    expect(res.request.outcome).toBe("posted message msg-1");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("reject blocks the action — the executor never runs — and records the reason", async () => {
    const { service, executor } = makeService(store);
    const pending = await service.request({
      workspaceId: WS,
      requestedByMemberId: REQUESTER,
      action: { kind: "external_send", summary: "send it" },
    });
    const res = await service.reject(pending.id, WS, APPROVER, "not authorized");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.request.status).toBe("rejected");
    expect(res.request.decisionReason).toBe("not authorized");
    expect(res.request.executedAt).toBeNull();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("refuses to re-decide a terminal request (audit integrity)", async () => {
    const { service } = makeService(store);
    const pending = await service.request({
      workspaceId: WS,
      requestedByMemberId: REQUESTER,
      action: { kind: "external_send", summary: "send it" },
    });
    await service.approve(pending.id, WS, APPROVER);
    const again = await service.reject(pending.id, WS, APPROVER, "changed my mind");
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.code).toBe("already_decided");
  });

  it("expires a pending request past its TTL and refuses the decision", async () => {
    const created = new Date("2026-06-08T00:00:00Z");
    const { service: creator } = makeService(store, created);
    const pending = await creator.request({
      workspaceId: WS,
      requestedByMemberId: REQUESTER,
      action: { kind: "external_send", summary: "send it" },
    });

    // a day-and-change later, well past the default 24h TTL
    const later = new Date("2026-06-09T01:00:00Z");
    const { service, executor } = makeService(store, later);
    const res = await service.approve(pending.id, WS, APPROVER);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("expired");
    expect(executor.execute).not.toHaveBeenCalled();
    expect((await store.getById(pending.id, WS))?.status).toBe("expired");
  });

  it("returns not_found for an unknown id or a cross-workspace id", async () => {
    const { service } = makeService(store);
    const pending = await service.request({
      workspaceId: WS,
      requestedByMemberId: REQUESTER,
      action: { kind: "external_send", summary: "send it" },
    });
    expect((await service.approve("nope", WS, APPROVER)).ok).toBe(false);
    // same id, different workspace → invisible
    const cross = await service.approve(pending.id, "ws-2", APPROVER);
    expect(cross.ok).toBe(false);
    if (cross.ok) throw new Error("unreachable");
    expect(cross.code).toBe("not_found");
  });
});
