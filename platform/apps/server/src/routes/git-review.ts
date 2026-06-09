import type { FastifyInstance, FastifyReply } from "fastify";
import type { DiffMode, SessionDiff } from "@reload/shared";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getAgentSession, setSessionGitRefs } from "../db/repositories/agent-sessions.js";
import {
  createPullRequest,
  getPullRequest,
  listPullRequests,
  toPrDto,
  updatePrChecks,
} from "../db/repositories/pull-requests.js";
import {
  createReviewComment,
  listReviewComments,
  listUndeliveredComments,
  markCommentsDelivered,
  toCommentDto,
  type ReviewCommentRow,
} from "../db/repositories/review-comments.js";
import { publishPullRequestEvent, publishReviewCommentEvent } from "../realtime/bus.js";
import type { SessionManager } from "../runtime/manager.js";
import type { GitWorkspaceService } from "../git/workspace.js";
import type { GitHubProvider } from "../github/provider.js";
import { GitHubUnavailableError } from "../github/none.js";

export interface GitReviewRoutesOptions {
  sessionManager: SessionManager;
  /** Present only when a git repo is configured (opt-in). Absent → git/PR routes return 501. */
  gitWorkspace?: GitWorkspaceService;
  gitHubProvider: GitHubProvider;
}

/**
 * Git / PR / diff / review routes (#51, ADR-0028). Each agent session runs in a git worktree on
 * branch `agent/<sessionId>`; these routes expose its diff, open a GitHub PR, surface checks, and
 * route review comments back to the agent as a new session. Every route is identity + channel-
 * capability gated and IDOR-scoped to `:cid` (a session/PR/comment is only ever read scoped to the
 * channel in the URL). No client string reaches a git ref or a shell.
 */
export async function gitReviewRoutes(
  app: FastifyInstance,
  opts: GitReviewRoutesOptions,
): Promise<void> {
  const { sessionManager, gitWorkspace, gitHubProvider } = opts;

  /** 501 unless a git workspace is configured. */
  function requireGit(reply: FastifyReply): GitWorkspaceService | undefined {
    if (!gitWorkspace) {
      reply.code(501).send({ error: "git workspace not configured" });
      return undefined;
    }
    return gitWorkspace;
  }

  // --- diff: the session's reviewable changes (cumulative or latest turn) ---
  app.get("/channels/:cid/agent-sessions/:id/diff", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "read", reply))) return;
    const session = await getAgentSession(id, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const git = requireGit(reply);
    if (!git) return;
    if (!git.hasWorktree(id)) {
      return reply.code(409).send({ error: "session has no git worktree" });
    }
    const mode: DiffMode = (req.query as { mode?: string }).mode === "turn" ? "turn" : "cumulative";

    // Lazy commit: turn the agent's (possibly uncommitted) edits into a reviewable diff without
    // touching the SessionManager. Persist the refs so the web client can show them without a worktree.
    const head = await git.commitTurn(id, "review snapshot");
    await setSessionGitRefs(id, { branch: git.branchFor(id), baseBranch: git.baseBranch, headSha: head });

    const diff = await git.diff(id, mode);
    const body: SessionDiff = {
      sessionId: id,
      branch: diff.branch,
      baseBranch: diff.baseBranch,
      mode: diff.mode,
      patch: diff.patch,
      files: diff.files,
    };
    return body;
  });

  // --- create a PR from the session's branch ---
  app.post("/channels/:cid/agent-sessions/:id/pull-request", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "write", reply))) return;
    const session = await getAgentSession(id, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const git = requireGit(reply);
    if (!git) return;
    if (!git.hasWorktree(id)) {
      return reply.code(409).send({ error: "session has no git worktree" });
    }

    const b = req.body as { title?: string; body?: string; draft?: boolean };
    if (!b.title) return reply.code(400).send({ error: "title required" });

    const branch = git.branchFor(id);
    const head = await git.commitTurn(id, b.title);
    await setSessionGitRefs(id, { branch, baseBranch: git.baseBranch, headSha: head });

    let ref;
    try {
      ref = await gitHubProvider.createPullRequest({
        repoRoot: git.repoRoot,
        baseBranch: git.baseBranch,
        headBranch: branch,
        title: b.title,
        body: b.body ?? "",
        draft: b.draft ?? false,
      });
    } catch (err) {
      if (err instanceof GitHubUnavailableError) {
        return reply.code(501).send({ error: err.message });
      }
      throw err;
    }

    const row = await createPullRequest({
      workspaceId: identity.workspaceId,
      channelId: cid,
      sessionId: id,
      number: ref.number,
      url: ref.url,
      title: b.title,
      body: b.body ?? null,
      draft: b.draft ?? false,
      state: ref.state,
      baseBranch: git.baseBranch,
      headBranch: branch,
      provider: gitHubProvider.kind,
      createdByMemberId: identity.memberId,
    });
    const dto = toPrDto(row);
    publishPullRequestEvent(cid, dto).catch(() => {
      /* best-effort realtime; row is persisted */
    });
    return reply.code(201).send({ pullRequest: dto });
  });

  // --- list / get PRs ---
  app.get("/channels/:cid/pull-requests", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(identity, cid, "read", reply))) return;
    return (await listPullRequests(cid)).map(toPrDto);
  });

  app.get("/channels/:cid/pull-requests/:id", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "read", reply))) return;
    const pr = await getPullRequest(id, cid);
    if (!pr) return reply.code(404).send({ error: "pull request not found" });
    return toPrDto(pr);
  });

  // --- refresh checks from GitHub ---
  app.post("/channels/:cid/pull-requests/:id/checks/refresh", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "write", reply))) return;
    const pr = await getPullRequest(id, cid);
    if (!pr) return reply.code(404).send({ error: "pull request not found" });
    const git = requireGit(reply);
    if (!git) return;

    let checks;
    try {
      checks = await gitHubProvider.getChecks({
        repoRoot: git.repoRoot,
        headBranch: pr.headBranch,
        prNumber: pr.number,
      });
    } catch (err) {
      if (err instanceof GitHubUnavailableError) {
        return reply.code(501).send({ error: err.message });
      }
      throw err;
    }

    await updatePrChecks(id, cid, checks.status);
    const updated = await getPullRequest(id, cid);
    if (updated) {
      publishPullRequestEvent(cid, toPrDto(updated)).catch(() => {});
    }
    return { checksStatus: checks.status, runs: checks.runs };
  });

  // --- forward failing CI to the agent as a new session ---
  app.post("/channels/:cid/pull-requests/:id/fix-ci", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "write", reply))) return;
    const pr = await getPullRequest(id, cid);
    if (!pr) return reply.code(404).send({ error: "pull request not found" });
    if (!pr.sessionId) return reply.code(409).send({ error: "PR has no originating session" });
    const session = await getAgentSession(pr.sessionId, cid);
    if (!session) return reply.code(409).send({ error: "originating session not found" });
    const git = requireGit(reply);
    if (!git) return;

    let logs: string;
    try {
      logs = await gitHubProvider.getFailingLogs({
        repoRoot: git.repoRoot,
        headBranch: pr.headBranch,
        prNumber: pr.number,
      });
    } catch (err) {
      if (err instanceof GitHubUnavailableError) {
        return reply.code(501).send({ error: err.message });
      }
      throw err;
    }

    const task = `CI is failing on PR #${pr.number ?? "?"} (branch ${pr.headBranch}). Investigate and fix it.\n\nFailing checks:\n${logs}`;
    const followUp = await sessionManager.launch({
      workspaceId: identity.workspaceId,
      channelId: cid,
      agentMemberId: session.agentMemberId,
      createdByMemberId: identity.memberId,
      task,
    });
    return reply.code(202).send({ sessionId: followUp.id });
  });

  // --- review comments on a session's diff ---
  app.get("/channels/:cid/agent-sessions/:id/review-comments", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "read", reply))) return;
    const session = await getAgentSession(id, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return (await listReviewComments(id, cid)).map(toCommentDto);
  });

  app.post("/channels/:cid/agent-sessions/:id/review-comments", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "write", reply))) return;
    const session = await getAgentSession(id, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });

    const b = req.body as {
      filePath?: string;
      lineStart?: number;
      lineEnd?: number;
      body?: string;
      pullRequestId?: string;
    };
    if (!b.filePath) return reply.code(400).send({ error: "filePath required" });
    if (!b.body) return reply.code(400).send({ error: "body required" });

    const row = await createReviewComment({
      workspaceId: identity.workspaceId,
      channelId: cid,
      sessionId: id,
      pullRequestId: b.pullRequestId ?? null,
      filePath: b.filePath,
      lineStart: b.lineStart ?? null,
      lineEnd: b.lineEnd ?? null,
      body: b.body,
      authorMemberId: identity.memberId,
    });
    const dto = toCommentDto(row);
    publishReviewCommentEvent(cid, dto).catch(() => {});
    return reply.code(201).send({ comment: dto });
  });

  // --- deliver review comments back to the agent as a new session (the round trip) ---
  app.post("/channels/:cid/agent-sessions/:id/review-comments/deliver", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid, id } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(identity, cid, "write", reply))) return;
    const session = await getAgentSession(id, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });

    const pending = await listUndeliveredComments(id, cid);
    if (pending.length === 0) {
      return reply.code(200).send({ sessionId: null, deliveredCount: 0 });
    }

    const followUp = await sessionManager.launch({
      workspaceId: identity.workspaceId,
      channelId: cid,
      agentMemberId: session.agentMemberId,
      createdByMemberId: identity.memberId,
      task: formatCommentsTask(pending),
    });
    await markCommentsDelivered(
      pending.map((c) => c.id),
      followUp.id,
    );
    return reply.code(202).send({ sessionId: followUp.id, deliveredCount: pending.length });
  });
}

/** Render review comments into a task the follow-up agent session acts on. */
function formatCommentsTask(comments: ReviewCommentRow[]): string {
  const lines = comments.map((c) => {
    const loc = c.lineStart
      ? `${c.filePath}:${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `-${c.lineEnd}` : ""}`
      : c.filePath;
    return `- ${loc} — ${c.body}`;
  });
  return `Address these review comments on your changes, then commit the fixes:\n${lines.join("\n")}`;
}
