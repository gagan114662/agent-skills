import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * #634 — runs must never fail silently. Hermetic unit test of the agent-session HTTP contract that
 * surfaces a failed run's cause and offers a retry: auth, the DB repositories, and config are mocked,
 * and the SessionManager is an in-memory fake — so this proves the route logic (failure enrichment on
 * list/get, and the retry endpoint's validation / IDOR-scoping / re-launch) with no Postgres. The real
 * end-to-end behaviour against Postgres is covered by test/integration/agent-sessions.test.ts.
 */

const IDENTITY = { workspaceId: "w1", memberId: "me1", kind: "human" as const, displayName: "Ada" };

const requireIdentity = vi.fn(async () => IDENTITY as unknown);
const requireChannelCapability = vi.fn(async () => ({ isArchived: false }) as unknown);

const getAgentSession = vi.fn();
const listAgentSessions = vi.fn(async () => []);

const getWorkspaceMember = vi.fn(async () => ({ id: "ag1", kind: "agent" }) as unknown);
const addChannelMember = vi.fn(async () => {});
const grantCapability = vi.fn(async () => {});
const loadConfig = vi.fn(() => ({ models: { defaultModel: null } }) as unknown);

vi.mock("../../src/auth/guard.js", () => ({ requireIdentity }));
vi.mock("../../src/auth/access.js", () => ({ requireChannelCapability }));
vi.mock("../../src/db/repositories/agent-sessions.js", () => ({ getAgentSession, listAgentSessions }));
vi.mock("../../src/db/repositories/members.js", () => ({ getWorkspaceMember }));
vi.mock("../../src/db/repositories/channels.js", () => ({ addChannelMember }));
vi.mock("../../src/db/repositories/permissions.js", () => ({ grantCapability }));
vi.mock("../../src/config/loader.js", () => ({ loadConfig }));

const { agentSessionRoutes, sessionFailure } = await import("../../src/routes/agent-sessions.js");

/** A failed run row as the repos return it (status + exit + redacted result tail). */
const FAILED_SESSION = {
  id: "s1",
  workspaceId: "w1",
  channelId: "c1",
  agentMemberId: "ag1",
  status: "failed",
  exitCode: 1,
  result: 'API Error: 529 {"type":"overloaded_error"}',
  harness: "claude-code",
  provider: null,
  model: null,
  effort: null,
  mode: null,
  branch: null,
};

const sessionManager = {
  launch: vi.fn(async () => ({
    id: "s2",
    status: "provisioning",
    runtime: "local",
    harness: "claude-code",
    agentMemberId: "ag1",
    provider: null,
    model: null,
    effort: null,
    mode: null,
  })),
  cancel: vi.fn(async () => true),
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await agentSessionRoutes(app, { sessionManager: sessionManager as any });
  await app.ready();
  return app;
}

describe("sessionFailure (#634 — never-silent failure derivation)", () => {
  it("returns null for a live or cleanly-completed run", () => {
    expect(sessionFailure({ status: "provisioning", exitCode: null, result: null })).toBeNull();
    expect(sessionFailure({ status: "running", exitCode: null, result: null })).toBeNull();
    expect(sessionFailure({ status: "completed", exitCode: 0, result: "done" })).toBeNull();
  });

  it("classifies a failed run into a human-readable cause (overload → retry-forward copy)", () => {
    const f = sessionFailure({ status: "failed", exitCode: 1, result: "529 overloaded_error" });
    expect(f?.failureClass).toBe("overloaded");
    expect(f?.headline).toBeTruthy();
    expect(f?.detail.toLowerCase()).toContain("retry");
  });

  it("never echoes the raw result tail (no secret leakage)", () => {
    const secret = "sk-ant-oat-SECRETTOKEN";
    const f = sessionFailure({ status: "failed", exitCode: 1, result: `auth error token=${secret}` });
    expect(JSON.stringify(f)).not.toContain(secret);
  });
});

describe("agent-session routes (#634, hermetic app.inject + fakes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireChannelCapability.mockResolvedValue({ isArchived: false } as unknown);
    getWorkspaceMember.mockResolvedValue({ id: "ag1", kind: "agent" } as unknown);
  });

  it("GET one enriches a failed run with its classified failure cause", async () => {
    getAgentSession.mockResolvedValue(FAILED_SESSION);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/channels/c1/agent-sessions/s1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().failure).toMatchObject({ failureClass: "overloaded" });
    expect(res.json().failure.headline).toBeTruthy();
    await app.close();
  });

  it("GET list attaches failure=null for non-failed runs and a cause for failed ones", async () => {
    listAgentSessions.mockResolvedValue([
      FAILED_SESSION,
      { ...FAILED_SESSION, id: "ok", status: "completed", exitCode: 0, result: "shipped" },
    ] as unknown as never);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/channels/c1/agent-sessions" });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0].failure.failureClass).toBe("overloaded");
    expect(rows[1].failure).toBeNull();
    await app.close();
  });

  it("POST retry 404s when the run is not in the channel (IDOR scope)", async () => {
    getAgentSession.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/nope/retry",
      payload: { task: "do it again" },
    });
    expect(res.statusCode).toBe(404);
    expect(sessionManager.launch).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST retry 409s for a run that did not fail (nothing to retry)", async () => {
    getAgentSession.mockResolvedValue({ ...FAILED_SESSION, status: "completed", exitCode: 0, result: "ok" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/retry",
      payload: { task: "again" },
    });
    expect(res.statusCode).toBe(409);
    expect(sessionManager.launch).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST retry 400s without a re-briefed task", async () => {
    getAgentSession.mockResolvedValue(FAILED_SESSION);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/channels/c1/agent-sessions/s1/retry", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(sessionManager.launch).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST retry re-launches the SAME agent + harness on the re-briefed task (202)", async () => {
    getAgentSession.mockResolvedValue(FAILED_SESSION);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/retry",
      payload: { task: "ship the homepage again" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: "s2", retriedFrom: "s1" });
    expect(sessionManager.launch).toHaveBeenCalledOnce();
    expect(sessionManager.launch.mock.calls[0]![0]).toMatchObject({
      channelId: "c1",
      agentMemberId: "ag1",
      task: "ship the homepage again",
      harness: "claude-code",
    });
    await app.close();
  });

  it("POST retry 404s when the prior agent is no longer an agent member of the workspace", async () => {
    getAgentSession.mockResolvedValue(FAILED_SESSION);
    getWorkspaceMember.mockResolvedValue(undefined as unknown);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/retry",
      payload: { task: "again" },
    });
    expect(res.statusCode).toBe(404);
    expect(sessionManager.launch).not.toHaveBeenCalled();
    await app.close();
  });
});
