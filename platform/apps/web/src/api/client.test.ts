import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./client.js";

/** Build a fetch stub that records the last call and returns a canned JSON response. */
function stubFetch(status: number, body: unknown): typeof fetch {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api client", () => {
  it("login posts credentials as JSON with cookies included", async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await api.login("ada@x.com", "pw");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({ email: "ada@x.com", password: "pw" });
  });

  it("me() returns the identity object", async () => {
    stubFetch(200, {
      workspaceId: "w1",
      memberId: "m1",
      kind: "human",
      displayName: "Ada",
    });
    const me = await api.me();
    expect(me).toEqual({ workspaceId: "w1", memberId: "m1", kind: "human", displayName: "Ada" });
  });

  it("postMessage sends body and optional parentMessageId", async () => {
    const fetchMock = stubFetch(201, {
      id: "msg1",
      channelId: "c1",
      authorMemberId: "m1",
      parentMessageId: "root1",
      alsoSentToChannel: false,
      body: "hi",
    });
    const msg = await api.postMessage("c1", "hi", "root1");

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/channels/c1/messages");
    expect(JSON.parse(init.body)).toEqual({ body: "hi", parentMessageId: "root1" });
    expect(msg.id).toBe("msg1");
  });

  it("searchMembers unwraps the search envelope into results", async () => {
    stubFetch(200, {
      query: "a",
      limit: 20,
      offset: 0,
      results: [{ id: "m1", kind: "agent", displayName: "Atlas" }],
    });
    const hits = await api.searchMembers("w1", "a");
    expect(hits).toEqual([{ id: "m1", kind: "agent", displayName: "Atlas" }]);
  });

  it("throws ApiError carrying the server error message and status on non-2xx", async () => {
    stubFetch(401, { error: "invalid credentials" });
    await expect(api.login("bad", "creds")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "invalid credentials",
    } satisfies Partial<ApiError>);
  });

  it("startCheckout posts the plan + a return URL so the hosted link comes back into the app (#215)", async () => {
    const fetchMock = stubFetch(201, { url: "https://pay.example/abc", planKey: "pro" });
    await api.billing.startCheckout("w1", "pro");

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/workspaces/w1/billing/checkout");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.planKey).toBe("pro");
    expect(body.billingInterval).toBe("month");
    // The default return URL carries the success flag the SPA reads on return.
    expect(body.returnUrl).toMatch(/checkout=success/);
  });
});
