import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Hermetic unit test of the durable-log (#665) and failing-tool (#666) read routes wired into the traces
 * router. Auth and the log service are mocked, so this proves the HTTP contract — workspace-scoped RBAC,
 * the run-log page + cursor, and the failing-tool-call surface — with no Postgres.
 */

const IDENTITY = { workspaceId: "w1", memberId: "me1", kind: "human" as const, displayName: "Ada" };
const requireIdentity = vi.fn(async () => IDENTITY as unknown);
const requireMemoryCapability = vi.fn(async () => true);

const getLog = vi.fn();
const getFailure = vi.fn();

vi.mock("../../src/auth/guard.js", () => ({ requireIdentity }));
vi.mock("../../src/auth/access.js", () => ({ requireMemoryCapability }));
vi.mock("../../src/trace/default.js", () => ({
  createDefaultTraceService: () => ({ getTrace: vi.fn(), replay: vi.fn(), listRuns: vi.fn(async () => []) }),
}));
vi.mock("../../src/observability/cost/index.js", () => ({
  createDefaultCostService: () => ({ getRunCost: vi.fn(), getSummary: vi.fn() }),
}));
vi.mock("../../src/observability/logs/index.js", () => ({
  createDefaultRunLogService: () => ({ getLog, getFailure }),
}));

const { tracesRoutes } = await import("../../src/routes/traces.js");

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  requireIdentity.mockResolvedValue(IDENTITY as unknown);
  requireMemoryCapability.mockResolvedValue(true);
  app = Fastify();
  await app.register(tracesRoutes);
  await app.ready();
});

describe("GET /workspaces/:wid/traces/:runId/logs (#665)", () => {
  it("returns the persisted log page with a poll cursor", async () => {
    getLog.mockResolvedValueOnce({
      runId: "run-1",
      lines: [
        { id: "line-1", workspaceId: "w1", runId: "run-1", seq: 1, stream: "stdout", text: "booting", occurredAt: new Date("2026-06-22T00:00:00Z") },
        { id: "line-2", workspaceId: "w1", runId: "run-1", seq: 2, stream: "stderr", text: "warn", occurredAt: new Date("2026-06-22T00:00:01Z") },
      ],
      cursor: 2,
    });
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/logs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cursor).toBe(2);
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]).toMatchObject({ stream: "stdout", text: "booting" });
  });

  it("forwards afterSeq + limit to the service", async () => {
    getLog.mockResolvedValueOnce({ runId: "run-1", lines: [], cursor: 5 });
    await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/logs?afterSeq=5&limit=100" });
    expect(getLog).toHaveBeenCalledWith("w1", "run-1", { afterSeq: 5, limit: 100 });
  });

  it("returns 200 with an empty page for a run that has no persisted log yet", async () => {
    getLog.mockResolvedValueOnce({ runId: "run-1", lines: [], cursor: 0 });
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/logs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines).toEqual([]);
  });

  it("denies a member without read capability (#3 IDOR)", async () => {
    requireMemoryCapability.mockImplementationOnce(async (_id, _wid, _cap, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      reply.code(403).send({ error: "forbidden" });
      return false;
    });
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/logs" });
    expect(res.statusCode).toBe(403);
    expect(getLog).not.toHaveBeenCalled();
  });
});

describe("GET /workspaces/:wid/traces/:runId/failure (#666)", () => {
  it("names the failing tool call and shows its error", async () => {
    getFailure.mockResolvedValueOnce({
      workspaceId: "w1",
      runId: "run-1",
      toolName: "web.fetch",
      args: { url: "https://example.com" },
      error: "ETIMEDOUT after 30s",
      occurredAt: new Date("2026-06-22T00:00:05Z"),
    });
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/failure" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).toBe("run-1");
    expect(body.failure).toMatchObject({
      toolName: "web.fetch",
      error: "ETIMEDOUT after 30s",
      args: { url: "https://example.com" },
    });
  });

  it("returns failure: null for a successful run", async () => {
    getFailure.mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/failure" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: "run-1", failure: null });
  });

  it("denies a member without read capability (#3 IDOR)", async () => {
    requireMemoryCapability.mockImplementationOnce(async (_id, _wid, _cap, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      reply.code(403).send({ error: "forbidden" });
      return false;
    });
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/traces/run-1/failure" });
    expect(res.statusCode).toBe(403);
    expect(getFailure).not.toHaveBeenCalled();
  });
});
