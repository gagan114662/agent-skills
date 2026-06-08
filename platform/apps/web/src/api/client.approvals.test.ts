import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client.js";

/** Build a fetch stub that records calls and returns a canned JSON response. */
function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function lastCall(fn: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fn.mock.calls.at(-1) as [string, RequestInit];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api.approvals", () => {
  it("listApprovals hits the workspace queue with an optional status filter", async () => {
    const fetchMock = stubFetch(200, []);
    await api.approvals.list("w1");
    expect(lastCall(fetchMock)[0]).toBe("/workspaces/w1/approvals");

    await api.approvals.list("w1", "pending");
    expect(lastCall(fetchMock)[0]).toBe("/workspaces/w1/approvals?status=pending");
  });

  it("get and events resolve a single request by id", async () => {
    const fetchMock = stubFetch(200, []);
    await api.approvals.get("r1");
    expect(lastCall(fetchMock)[0]).toBe("/approvals/r1");
    await api.approvals.events("r1");
    expect(lastCall(fetchMock)[0]).toBe("/approvals/r1/events");
  });

  it("approve posts an optional reason", async () => {
    const fetchMock = stubFetch(200, { status: "executed", result: {}, request: { id: "r1" } });
    const res = await api.approvals.approve("r1", "looks safe");
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/approvals/r1/approve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "looks safe" });
    expect(res.request.id).toBe("r1");
  });

  it("reject posts the required reason", async () => {
    const fetchMock = stubFetch(200, { status: "rejected", request: { id: "r1" } });
    await api.approvals.reject("r1", "not authorized");
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/approvals/r1/reject");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "not authorized" });
  });

  it("policy CRUD targets the workspace approval-policies endpoints", async () => {
    const fetchMock = stubFetch(200, []);
    await api.approvals.listPolicies("w1");
    expect(lastCall(fetchMock)[0]).toBe("/workspaces/w1/approval-policies");

    stubFetch(201, { id: "p1" });
    const fetchMock2 = vi.mocked(fetch);
    await api.approvals.upsertPolicy("w1", { actionType: "external.send", maxAutoAmount: 100 });
    const [url, init] = lastCall(fetchMock2 as unknown as ReturnType<typeof vi.fn>);
    expect(url).toBe("/workspaces/w1/approval-policies");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      actionType: "external.send",
      maxAutoAmount: 100,
    });

    const delMock = stubFetch(200, { ok: true });
    await api.approvals.deletePolicy("w1", "p1");
    const [delUrl, delInit] = lastCall(delMock);
    expect(delUrl).toBe("/workspaces/w1/approval-policies/p1");
    expect(delInit.method).toBe("DELETE");
  });

  it("submitAction posts the action envelope (used by the demo to manufacture a gated request)", async () => {
    const fetchMock = stubFetch(202, { status: "pending", reason: "policy", request: { id: "r1" } });
    await api.approvals.submitAction("w1", {
      actionType: "external.send",
      payload: { to: "ops@x.com" },
      amount: 250,
    });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/workspaces/w1/actions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      actionType: "external.send",
      payload: { to: "ops@x.com" },
      amount: 250,
    });
  });
});
