import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Hermetic unit test of the #51 git/PR/review HTTP contract (spec 28 promised
 * "routes/git-review.test.ts via app.inject with fakes"). Auth, the DB repositories, and the
 * realtime bus are mocked, and the git workspace / GitHub provider / SessionManager are passed in
 * as in-memory fakes — so this proves the route logic (status codes, validation, IDOR-scoping,
 * the 501-without-git gate, the comment→follow-up round trip) with no Postgres/Redis. The real
 * end-to-end behaviour against Postgres is covered by test/integration/git-review.test.ts.
 */

const IDENTITY = { workspaceId: "w1", memberId: "me1", kind: "human" as const, displayName: "Ada" };

const requireIdentity = vi.fn(async () => IDENTITY as unknown);
const requireChannelCapability = vi.fn(async () => true);

const getAgentSession = vi.fn();
const setSessionGitRefs = vi.fn(async () => {});

const createPullRequest = vi.fn();
const getPullRequest = vi.fn();
const listPullRequests = vi.fn(async () => []);
const updatePrChecks = vi.fn(async () => {});
const toPrDto = vi.fn((row: unknown) => row);

const createReviewComment = vi.fn();
const listReviewComments = vi.fn(async () => []);
const listUndeliveredComments = vi.fn(async () => []);
const markCommentsDelivered = vi.fn(async () => {});
const toCommentDto = vi.fn((row: unknown) => row);

vi.mock("../../src/auth/guard.js", () => ({ requireIdentity }));
vi.mock("../../src/auth/access.js", () => ({ requireChannelCapability }));
vi.mock("../../src/db/repositories/agent-sessions.js", () => ({ getAgentSession, setSessionGitRefs }));
vi.mock("../../src/db/repositories/pull-requests.js", () => ({
  createPullRequest,
  getPullRequest,
  listPullRequests,
  updatePrChecks,
  toPrDto,
}));
vi.mock("../../src/db/repositories/review-comments.js", () => ({
  createReviewComment,
  listReviewComments,
  listUndeliveredComments,
  markCommentsDelivered,
  toCommentDto,
}));
vi.mock("../../src/realtime/bus.js", () => ({
  publishPullRequestEvent: vi.fn(async () => {}),
  publishReviewCommentEvent: vi.fn(async () => {}),
}));

const { gitReviewRoutes } = await import("../../src/routes/git-review.js");

const SESSION = { id: "s1", channelId: "c1", agentMemberId: "ag1", status: "completed" };

function fakeGit(over: Record<string, unknown> = {}) {
  return {
    repoRoot: "/repo",
    baseBranch: "main",
    branchFor: (id: string) => `agent/${id}`,
    hasWorktree: vi.fn(() => true),
    commitTurn: vi.fn(async () => "deadbeef"),
    diff: vi.fn(async (id: string, mode: string) => ({
      branch: `agent/${id}`,
      baseBranch: "main",
      mode,
      patch: "diff --git a/x b/x",
      files: [{ path: "x", additions: 1, deletions: 0 }],
    })),
    ...over,
  };
}

const sessionManager = { launch: vi.fn(async () => ({ id: "follow-up" })) };
const gitHubProvider = {
  kind: "gh" as const,
  createPullRequest: vi.fn(async () => ({ number: 7, url: "https://gh/pr/7", state: "open" as const })),
  getChecks: vi.fn(async () => ({ status: "success" as const, runs: [] })),
  getFailingLogs: vi.fn(async () => "boom"),
};

/** Build a bare Fastify app with only the git-review routes + the given fakes. */
async function buildApp(opts: { gitWorkspace?: unknown } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await gitReviewRoutes(app, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionManager: sessionManager as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitWorkspace: ("gitWorkspace" in opts ? opts.gitWorkspace : fakeGit()) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitHubProvider: gitHubProvider as any,
  });
  await app.ready();
  return app;
}

describe("git/PR/review routes (hermetic, app.inject + fakes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireChannelCapability.mockResolvedValue(true);
  });

  it("GET diff returns the session diff and persists the snapshot refs", async () => {
    getAgentSession.mockResolvedValue(SESSION);
    const git = fakeGit();
    const app = await buildApp({ gitWorkspace: git });
    const res = await app.inject({ method: "GET", url: "/channels/c1/agent-sessions/s1/diff" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: "s1", branch: "agent/s1", mode: "cumulative" });
    expect(git.commitTurn).toHaveBeenCalledOnce();
    expect(setSessionGitRefs).toHaveBeenCalledWith("s1", {
      branch: "agent/s1",
      baseBranch: "main",
      headSha: "deadbeef",
    });
    await app.close();
  });

  it("GET diff 404s when the session is not in the channel (IDOR scope)", async () => {
    getAgentSession.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/channels/c1/agent-sessions/nope/diff" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 501 for git routes when no workspace is configured", async () => {
    getAgentSession.mockResolvedValue(SESSION);
    const app = await buildApp({ gitWorkspace: undefined });
    const res = await app.inject({ method: "GET", url: "/channels/c1/agent-sessions/s1/diff" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "git workspace not configured" });
    await app.close();
  });

  it("POST pull-request requires a title", async () => {
    getAgentSession.mockResolvedValue(SESSION);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/pull-request",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST pull-request opens a PR via the provider and persists the row", async () => {
    getAgentSession.mockResolvedValue(SESSION);
    createPullRequest.mockImplementation(async (input: Record<string, unknown>) => ({ id: "pr1", ...input }));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/pull-request",
      payload: { title: "Ship it", draft: true },
    });
    expect(res.statusCode).toBe(201);
    expect(gitHubProvider.createPullRequest).toHaveBeenCalledOnce();
    expect(res.json().pullRequest).toMatchObject({ id: "pr1", number: 7, url: "https://gh/pr/7" });
    await app.close();
  });

  it("POST review-comment validates filePath and body", async () => {
    getAgentSession.mockResolvedValue(SESSION);
    const app = await buildApp();
    const missingBody = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/review-comments",
      payload: { filePath: "x.ts" },
    });
    expect(missingBody.statusCode).toBe(400);
    await app.close();
  });

  it("deliver with no pending comments returns 200 with no follow-up session", async () => {
    getAgentSession.mockResolvedValue(SESSION);
    listUndeliveredComments.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/review-comments/deliver",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: null, deliveredCount: 0 });
    expect(sessionManager.launch).not.toHaveBeenCalled();
    await app.close();
  });

  it("deliver launches a follow-up session and marks comments delivered", async () => {
    getAgentSession.mockResolvedValue(SESSION);
    listUndeliveredComments.mockResolvedValue([
      { id: "rc1", filePath: "x.ts", lineStart: 3, lineEnd: 3, body: "rename this" },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/channels/c1/agent-sessions/s1/review-comments/deliver",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sessionId: "follow-up", deliveredCount: 1 });
    expect(sessionManager.launch).toHaveBeenCalledOnce();
    expect(markCommentsDelivered).toHaveBeenCalledWith(["rc1"], "follow-up");
    await app.close();
  });
});
