import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "./store.js";
import { makeFakeApprovalDeps, makeRequest, makePolicy } from "../test/approvals-fixtures.js";

/** Drive a store to the `ready` phase with the given approval backend, then return helpers. */
async function ready(over: Parameters<typeof makeFakeApprovalDeps>[0] = {}): Promise<{
  store: Store;
  fire: (e: import("../api/types.js").ServerEvent) => void;
  approvals: ReturnType<typeof makeFakeApprovalDeps>["approvals"];
}> {
  const { deps, rt, approvals } = makeFakeApprovalDeps(over);
  const store = createStore(deps);
  await store.bootstrap();
  return { store, fire: rt.fire, approvals };
}

describe("store approvals slice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("seeds the pending count on workspace load", async () => {
    const { store } = await ready({
      pending: [makeRequest({ id: "r1" }), makeRequest({ id: "r2" })],
    });
    expect(store.getState().approvals.pendingCount).toBe(2);
  });

  it("loadApprovals fetches the queue for a status and exposes the rows", async () => {
    const { store } = await ready({
      executed: [makeRequest({ id: "e1", status: "executed" })],
    });
    await store.loadApprovals("executed");
    const s = store.getState().approvals;
    expect(s.status).toBe("executed");
    expect(s.requests.map((r) => r.id)).toEqual(["e1"]);
  });

  it("approving reconciles the pending queue (the decided row leaves)", async () => {
    const { store, approvals } = await ready({
      pending: [makeRequest({ id: "r1" }), makeRequest({ id: "r2" })],
    });
    await store.loadApprovals("pending");
    // After the decision, the backend no longer returns r1 as pending.
    approvals.setPending([makeRequest({ id: "r2" })]);
    await store.decideApprove("r1", "ok");

    expect(approvals.approve).toHaveBeenCalledWith("r1", "ok");
    const s = store.getState().approvals;
    expect(s.requests.map((r) => r.id)).toEqual(["r2"]);
    expect(s.pendingCount).toBe(1);
  });

  it("surfaces a decision conflict (409) without throwing, then reconciles", async () => {
    const { store, approvals } = await ready({ pending: [makeRequest({ id: "r1" })] });
    await store.loadApprovals("pending");
    approvals.approve.mockRejectedValueOnce(
      Object.assign(new Error("request already decided"), { status: 409 }),
    );
    approvals.setPending([]); // someone else decided it

    await store.decideApprove("r1");

    const s = store.getState().approvals;
    expect(s.error).toBe("request already decided");
    expect(s.requests).toEqual([]);
    expect(s.pendingCount).toBe(0);
  });

  it("opens a request with its audit timeline", async () => {
    const events = [
      { id: "ev1", requestId: "r1", type: "requested" as const, actorMemberId: "me1", detail: {}, createdAt: "2026-06-08T11:00:00Z" },
    ];
    const { store } = await ready({
      detail: makeRequest({ id: "r1" }),
      events,
    });
    await store.openRequest("r1");
    const s = store.getState().approvals;
    expect(s.activeRequest?.id).toBe("r1");
    expect(s.activeEvents).toEqual(events);
    store.closeRequest();
    expect(store.getState().approvals.activeRequest).toBeNull();
  });

  it("loads, adds and removes policies", async () => {
    const { store, approvals } = await ready({ policies: [makePolicy({ id: "p1" })] });
    await store.loadPolicies();
    expect(store.getState().approvals.policies.map((p) => p.id)).toEqual(["p1"]);

    approvals.setPolicies([makePolicy({ id: "p1" }), makePolicy({ id: "p2", actionType: "external.send" })]);
    await store.addPolicy({ actionType: "external.send", maxAutoAmount: 100 });
    expect(approvals.upsertPolicy).toHaveBeenCalledWith("w1", { actionType: "external.send", maxAutoAmount: 100 });
    expect(store.getState().approvals.policies).toHaveLength(2);

    approvals.setPolicies([makePolicy({ id: "p1" })]);
    await store.removePolicy("p2");
    expect(approvals.deletePolicy).toHaveBeenCalledWith("w1", "p2");
    expect(store.getState().approvals.policies.map((p) => p.id)).toEqual(["p1"]);
  });

  it("refreshes the pending queue live on an approval notification", async () => {
    const { store, fire, approvals } = await ready({ pending: [makeRequest({ id: "r1" })] });
    await store.loadApprovals("pending");
    expect(store.getState().approvals.requests).toHaveLength(1);

    approvals.setPending([makeRequest({ id: "r1" }), makeRequest({ id: "r2" })]);
    fire({
      type: "notification",
      notification: {
        id: "n1",
        type: "approval",
        recipientMemberId: "me1",
        actorMemberId: "ag1",
        channelId: null,
        messageId: null,
        taskId: null,
        excerpt: "Approval needed: send $250",
        createdAt: "2026-06-08T12:00:00Z",
      },
    });

    // The live refresh is async; wait a microtask-ish tick.
    await vi.waitFor(() => expect(store.getState().approvals.requests).toHaveLength(2));
    expect(store.getState().approvals.pendingCount).toBe(2);
  });

  it("ignores non-approval notifications for the queue", async () => {
    const { store, fire, approvals } = await ready({ pending: [makeRequest({ id: "r1" })] });
    await store.loadApprovals("pending");
    approvals.list.mockClear();
    fire({
      type: "notification",
      notification: {
        id: "n2",
        type: "mention",
        recipientMemberId: "me1",
        actorMemberId: "ag1",
        channelId: "c1",
        messageId: "m1",
        taskId: null,
        excerpt: "hi",
        createdAt: "2026-06-08T12:00:00Z",
      },
    });
    expect(approvals.list).not.toHaveBeenCalled();
  });
});
