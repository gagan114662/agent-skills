import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Hermetic unit test of the live-theater SSE contract (issue #624). Auth and the trace service are
 * mocked, so this proves the HTTP/SSE behaviour — 404 for an unknown run, and a *closed* run replaying
 * its full record over SSE then ending with `event: done` — with no Postgres and no open socket.
 * The live polling path over an *open* run is glue over `trace/theater.ts`, covered by its own unit test.
 */

const IDENTITY = { workspaceId: "w1", memberId: "me1", kind: "human" as const, displayName: "Ada" };
const requireIdentity = vi.fn(async () => IDENTITY as unknown);
const requireMemoryCapability = vi.fn(async () => true);

const getTrace = vi.fn();
const replay = vi.fn();
const listRuns = vi.fn(async () => []);

vi.mock("../../src/auth/guard.js", () => ({ requireIdentity }));
vi.mock("../../src/auth/access.js", () => ({ requireMemoryCapability }));
vi.mock("../../src/trace/default.js", () => ({
  createDefaultTraceService: () => ({ getTrace, replay, listRuns, listEvents: vi.fn(), getTraceRun: vi.fn() }),
}));

const { tracesRoutes } = await import("../../src/routes/traces.js");

function closedRunTrace() {
  return {
    run: { id: "run-1", workspaceId: "w1", status: "closed", eventCount: 2, label: "mark" },
    events: [
      { id: "e1", runId: "run-1", seq: 1, type: "model_response", turn: 0, label: "opus", payload: { reasoning: "draft the post" }, occurredAt: new Date("2026-06-22T00:00:00Z") },
      { id: "e2", runId: "run-1", seq: 2, type: "tool_call", turn: 0, label: "publish", payload: { command: "publish blog" }, occurredAt: new Date("2026-06-22T00:00:01Z") },
    ],
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  await app.register(tracesRoutes);
  await app.ready();
});

describe("GET /workspaces/:wid/traces/:runId/stream", () => {
  it("404s when the run is absent in this workspace", async () => {
    getTrace.mockResolvedValueOnce(undefined);
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/missing/stream" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("not found") });
  });

  it("replays a closed run over SSE and ends with event: done", async () => {
    getTrace.mockResolvedValue(closedRunTrace());
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/stream" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const body = res.body;
    expect(body).toContain("event: run");
    expect(body).toContain("event: event");
    expect(body).toContain('"phase":"reasoning"');
    expect(body).toContain('"phase":"action"');
    expect(body).toContain('"summary":"draft the post"');
    expect(body).toContain("event: done");
  });

  it("rejects a cross-workspace watcher (403) before streaming", async () => {
    // Mirror the real guard: it sends the 403 itself and returns false; the handler then bails.
    requireMemoryCapability.mockImplementationOnce(async (..._args: unknown[]) => {
      const reply = _args[3] as { code: (n: number) => { send: (b: unknown) => void } };
      reply.code(403).send({ error: "wrong workspace" });
      return false as unknown as true;
    });
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/stream" });
    expect(getTrace).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
