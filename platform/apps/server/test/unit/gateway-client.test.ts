import { describe, expect, it } from "vitest";
import { HttpGatewayRoutingClient } from "../../src/runtime/gateway-client.js";

/** Build a fake fetch that records the request and returns a canned response. */
function fakeFetch(
  responder: (url: string, init: RequestInit) => { status: number; body: unknown },
): {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    async fetchImpl(url: string, init: RequestInit) {
      calls.push({ url, init });
      const { status, body } = responder(url, init);
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return body;
        },
      } as Response;
    },
  };
}

const DECISION = {
  ok: true,
  text: "the answer",
  decision: {
    chosen: "claude-sonnet-4-6",
    initialChoice: "claude-haiku-4-5",
    stage: "orchestrator",
    rationale: "ratified claude-sonnet-4-6",
    validationVerdict: "accept",
    confidence: 0.8,
    escalations: [{ from: "claude-haiku-4-5", to: "claude-sonnet-4-6", reason: "low confidence" }],
    estCostCents: 0.2,
    actualCostCents: 0.3,
  },
};

describe("HttpGatewayRoutingClient", () => {
  it("POSTs /auto/complete with the tenant + prompt + ceiling and parses the decision", async () => {
    const f = fakeFetch(() => ({ status: 200, body: DECISION }));
    const client = new HttpGatewayRoutingClient({ baseUrl: "https://gw.example/", fetchImpl: f.fetchImpl, env: {} });
    const out = await client.route({ prompt: "fix it", tenant: "ws1", costCeilingCents: 5 });
    expect(out).not.toBeNull();
    expect(out!.chosen).toBe("claude-sonnet-4-6");
    // Regression guard: `ok` is a TOP-LEVEL body field, not on `decision` — must be true here.
    expect(out!.ok).toBe(true);
    expect(out!.validationVerdict).toBe("accept");
    expect(out!.escalations).toHaveLength(1);
    // URL is normalized (no double slash) and hits /auto/complete.
    expect(f.calls[0].url).toBe("https://gw.example/auto/complete");
    const sent = JSON.parse(f.calls[0].init.body as string);
    expect(sent).toMatchObject({ prompt: "fix it", tenant: "ws1", costCeilingCents: 5 });
  });

  it("attaches the gateway key as a bearer header from the env var (never in the body)", async () => {
    const f = fakeFetch(() => ({ status: 200, body: DECISION }));
    const client = new HttpGatewayRoutingClient({
      baseUrl: "https://gw.example",
      fetchImpl: f.fetchImpl,
      env: { LLM_GATEWAY_KEY: "secret-token" },
    });
    await client.route({ prompt: "x", tenant: "ws1" });
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
    // The secret must never appear in the request body.
    expect(f.calls[0].init.body as string).not.toContain("secret-token");
  });

  it("omits the auth header when no key is configured", async () => {
    const f = fakeFetch(() => ({ status: 200, body: DECISION }));
    const client = new HttpGatewayRoutingClient({ baseUrl: "https://gw.example", fetchImpl: f.fetchImpl, env: {} });
    await client.route({ prompt: "x", tenant: "ws1" });
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("returns null on a non-2xx (e.g. 404 = AUTO_ROUTING_ENABLED off on the gateway)", async () => {
    const f = fakeFetch(() => ({ status: 404, body: { error: "auto routing disabled" } }));
    const client = new HttpGatewayRoutingClient({ baseUrl: "https://gw.example", fetchImpl: f.fetchImpl, env: {} });
    expect(await client.route({ prompt: "x", tenant: "ws1" })).toBeNull();
  });

  it("returns null when fetch rejects (network/timeout)", async () => {
    const client = new HttpGatewayRoutingClient({
      baseUrl: "https://gw.example",
      env: {},
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await client.route({ prompt: "x", tenant: "ws1" })).toBeNull();
  });

  it("returns null when the body has no decision", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true, text: "hi" } }));
    const client = new HttpGatewayRoutingClient({ baseUrl: "https://gw.example", fetchImpl: f.fetchImpl, env: {} });
    expect(await client.route({ prompt: "x", tenant: "ws1" })).toBeNull();
  });
});
