/**
 * Unit tests for the action-gate service (issue #670) over the in-memory store. Exercises the full lifecycle —
 * guard → park → approve/reject → consume — plus the replay, single-use, expiry, and self-approval guarantees
 * that back the acceptance criterion "no public/irreversible action executes without a recorded approval".
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ActionGateService, ActionGateError } from "../../src/action-gate/service.js";
import { InMemoryGateRequestStore } from "../../src/action-gate/store.js";
import type { ActionGateCaps } from "../../src/action-gate/caps.js";

const WID = "ws-1";
const OWNER = "member-owner";
const AGENT = "member-agent";

const CAPS: ActionGateCaps = {
  approvalTtlMs: 1_000,
  extraIrreversibleVerbs: [],
  extraPublicVerbs: [],
  extraSafeVerbs: [],
};

function makeService(nowMs = 1_000) {
  let clock = nowMs;
  const store = new InMemoryGateRequestStore();
  const service = new ActionGateService({ store, caps: CAPS, now: () => new Date(clock) });
  return { store, service, advance: (ms: number) => (clock += ms), setNow: (ms: number) => (clock = ms) };
}

describe("guardAction — autonomous vs parked", () => {
  it("allows an internal+reversible action with no parked request", async () => {
    const { service, store } = makeService();
    const res = await service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action: { action: "db.read" } });
    expect(res.allowed).toBe(true);
    expect(res.request).toBeNull();
    expect(await store.list(WID)).toHaveLength(0);
  });

  it("parks a pending request for a public/irreversible action and never allows it inline", async () => {
    const { service, store } = makeService();
    const res = await service.guardAction({
      workspaceId: WID,
      requesterMemberId: AGENT,
      action: { action: "email.send", surface: "list@news", summary: "Launch email", payload: { count: 4200 } },
    });
    expect(res.allowed).toBe(false);
    expect(res.request).not.toBeNull();
    expect(res.request?.status).toBe("pending");
    expect(res.request?.klass).toBe("public+irreversible");
    expect(res.request?.summary).toBe("Launch email");
    expect(await store.list(WID, "pending")).toHaveLength(1);
  });
});

describe("approve → consume — the only path to execution", () => {
  let h: ReturnType<typeof makeService>;
  const action = { action: "page.publish", payload: { slug: "/launch" } };

  beforeEach(() => {
    h = makeService();
  });

  it("consumes an approved request once and marks it executed", async () => {
    const parked = await h.service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action });
    const id = parked.request!.id;

    await h.service.approve(WID, id, OWNER);
    const executed = await h.service.consumeApproval({ workspaceId: WID, requestId: id, requesterMemberId: AGENT, action });
    expect(executed.status).toBe("executed");

    // Single-use: a second consume cannot succeed.
    await expect(
      h.service.consumeApproval({ workspaceId: WID, requestId: id, requesterMemberId: AGENT, action }),
    ).rejects.toBeInstanceOf(ActionGateError);
  });

  it("refuses to consume a still-pending request (no approval recorded)", async () => {
    const parked = await h.service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action });
    await expect(
      h.service.consumeApproval({ workspaceId: WID, requestId: parked.request!.id, requesterMemberId: AGENT, action }),
    ).rejects.toThrow(/not approved/);
  });

  it("refuses to consume a rejected request", async () => {
    const parked = await h.service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action });
    await h.service.reject(WID, parked.request!.id, OWNER, "not now");
    await expect(
      h.service.consumeApproval({ workspaceId: WID, requestId: parked.request!.id, requesterMemberId: AGENT, action }),
    ).rejects.toThrow(/rejected/);
  });
});

describe("replay protection — an approval is bound to its exact action", () => {
  it("refuses to consume an approval for a different action (different payload)", async () => {
    const { service } = makeService();
    const deleteFive = { action: "record.delete", payload: { id: 5 } };
    const deleteNinetyNine = { action: "record.delete", payload: { id: 99 } };

    const parked = await service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action: deleteFive });
    await service.approve(WID, parked.request!.id, OWNER);

    await expect(
      service.consumeApproval({
        workspaceId: WID,
        requestId: parked.request!.id,
        requesterMemberId: AGENT,
        action: deleteNinetyNine,
      }),
    ).rejects.toThrow(/different action/);
  });
});

describe("expiry — an unactioned approval lazily expires", () => {
  it("cannot approve a request whose TTL has passed", async () => {
    const h = makeService();
    const parked = await h.service.guardAction({
      workspaceId: WID,
      requesterMemberId: AGENT,
      action: { action: "email.send" },
    });
    h.advance(CAPS.approvalTtlMs + 1);
    await expect(h.service.approve(WID, parked.request!.id, OWNER)).rejects.toThrow(/expired/);
    const after = await h.service.get(WID, parked.request!.id);
    expect(after?.status).toBe("expired");
  });

  it("cannot consume an approval after it expires", async () => {
    const h = makeService();
    const action = { action: "email.send" };
    const parked = await h.service.guardAction({ workspaceId: WID, requesterMemberId: AGENT, action });
    await h.service.approve(WID, parked.request!.id, OWNER);
    h.advance(CAPS.approvalTtlMs + 1);
    await expect(
      h.service.consumeApproval({ workspaceId: WID, requestId: parked.request!.id, requesterMemberId: AGENT, action }),
    ).rejects.toThrow(/expired/);
  });
});

describe("self-approval guard (opt-in) and tenant isolation", () => {
  it("forbids self-approval when asked", async () => {
    const { service } = makeService();
    const parked = await service.guardAction({
      workspaceId: WID,
      requesterMemberId: AGENT,
      action: { action: "email.send" },
    });
    await expect(
      service.approve(WID, parked.request!.id, AGENT, { forbidSelfApproval: true }),
    ).rejects.toThrow(/self-approval/);
    // A different approver is fine.
    const ok = await service.approve(WID, parked.request!.id, OWNER, { forbidSelfApproval: true });
    expect(ok.status).toBe("approved");
  });

  it("a request cannot be read or decided from another workspace (#3 IDOR)", async () => {
    const { service } = makeService();
    const parked = await service.guardAction({
      workspaceId: WID,
      requesterMemberId: AGENT,
      action: { action: "email.send" },
    });
    expect(await service.get("ws-other", parked.request!.id)).toBeNull();
    await expect(service.approve("ws-other", parked.request!.id, OWNER)).rejects.toThrow(/no such approval/);
  });
});
