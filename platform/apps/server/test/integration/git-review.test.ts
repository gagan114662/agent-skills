import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { GitWorkspaceService } from "../../src/git/workspace.js";
import { GitWorkspaceProvisioner } from "../../src/git/provisioner.js";
import { NoneGitHubProvider } from "../../src/github/none.js";
import type {
  ChecksResult,
  CreatePrInput,
  GitHubProvider,
  PullRequestRef,
} from "../../src/github/provider.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A real host harness that writes a file into its cwd (the session's git worktree), then exits. */
const WRITE_FILE_HARNESS = [
  "-e",
  "const fs=require('fs');" +
    "fs.writeFileSync('feature.ts','export const answer = 42;\\n');" +
    "console.log('agent: wrote feature.ts');",
];

/** A fake GitHub provider — no network, no token. Proves the PR/checks flow end-to-end. */
class FakeGitHubProvider implements GitHubProvider {
  readonly kind = "gh" as const;
  createPullRequest(_input: CreatePrInput): Promise<PullRequestRef> {
    return Promise.resolve({ number: 42, url: "https://github.com/o/r/pull/42", state: "open" });
  }
  getChecks(): Promise<ChecksResult> {
    return Promise.resolve({
      status: "failure",
      runs: [{ name: "build", status: "completed", conclusion: "failure", detailsUrl: null }],
    });
  }
  getFailingLogs(): Promise<string> {
    return Promise.resolve("✗ build — compilation error");
  }
}

const tmpRoots: string[] = [];
const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
  await Promise.allSettled([closeDb(), closeRedis()]);
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Create an isolated base git repo with one commit on `main` and a GitWorkspaceService over it. */
function makeGitWorkspace(): GitWorkspaceService {
  const root = mkdtempSync(join(tmpdir(), "git-review-it-"));
  tmpRoots.push(root);
  const repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  spawnSync("bash", ["-c", "echo '# base' > README.md"], { cwd: repoRoot });
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "init");
  return new GitWorkspaceService({
    repoRoot,
    worktreesRoot: join(root, "worktrees"),
    baseBranch: "main",
  });
}

/** Build an app whose sessions run in git worktrees, with the given GitHub provider. */
async function startApp(gitHubProvider: GitHubProvider): Promise<{
  app: FastifyInstance;
  gitWorkspace: GitWorkspaceService;
}> {
  const gitWorkspace = makeGitWorkspace();
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: WRITE_FILE_HARNESS },
    caps: { wallClockMs: 20_000, idleMs: 8_000 },
    logger: silentLogger,
    workspace: new GitWorkspaceProvisioner(gitWorkspace),
  });
  const app = buildApp({ sessionManager: manager, gitWorkspace, gitHubProvider });
  apps.push(app);
  return { app, gitWorkspace };
}

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `gr-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "agents" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Scout" },
  });
  return {
    cookie,
    workspaceId: me.workspaceId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

async function launchAndFinish(app: FastifyInstance, w: World, task: string): Promise<string> {
  const launch = await app.inject({
    method: "POST",
    url: `/channels/${w.channelId}/agent-sessions`,
    cookies: { rid: w.cookie },
    payload: { agentMemberId: w.agentMemberId, task },
  });
  expect(launch.statusCode).toBe(202);
  const sessionId = launch.json().id as string;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const body = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions/${sessionId}`,
        cookies: { rid: w.cookie },
      })
    ).json();
    if (body.status === "completed" || body.status === "failed") break;
    if (Date.now() > deadline) throw new Error(`session stuck in ${body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return sessionId;
}

describe("git/PR/review workflow (real Postgres, LocalRuntime, temp git repo, no GitHub)", () => {
  it("an agent's edits appear as a branch diff, comments deliver back, and a PR persists", async () => {
    const { app } = await startApp(new FakeGitHubProvider());
    const w = await seed(app);
    const sessionId = await launchAndFinish(app, w, "add the answer constant");

    // The agent's edit (in its worktree) is a reviewable cumulative diff.
    const diff = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/diff?mode=cumulative`,
      cookies: { rid: w.cookie },
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().branch).toBe(`agent/${sessionId}`);
    expect(diff.json().patch).toContain("feature.ts");
    expect(diff.json().patch).toContain("export const answer = 42;");
    expect(diff.json().files.map((f: { path: string }) => f.path)).toContain("feature.ts");

    // A multiline review comment attaches to the session's diff.
    const comment = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/review-comments`,
      cookies: { rid: w.cookie },
      payload: { filePath: "feature.ts", lineStart: 1, lineEnd: 1, body: "name it ANSWER" },
    });
    expect(comment.statusCode).toBe(201);

    // Delivering routes the comment back to the agent as a NEW session (the round trip).
    const deliver = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/review-comments/deliver`,
      cookies: { rid: w.cookie },
    });
    expect(deliver.statusCode).toBe(202);
    expect(deliver.json().deliveredCount).toBe(1);
    const followUpId = deliver.json().sessionId as string;
    expect(followUpId).toBeTruthy();

    // The comment now records the follow-up session it was delivered to.
    const comments = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions/${sessionId}/review-comments`,
        cookies: { rid: w.cookie },
      })
    ).json() as { deliveredToSessionId: string | null }[];
    expect(comments[0]!.deliveredToSessionId).toBe(followUpId);

    // Opening a PR persists a row reflecting the provider's response.
    const pr = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/pull-request`,
      cookies: { rid: w.cookie },
      payload: { title: "Add answer", body: "the answer is 42", draft: false },
    });
    expect(pr.statusCode).toBe(201);
    expect(pr.json().pullRequest.number).toBe(42);
    const prId = pr.json().pullRequest.id as string;

    const prs = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/pull-requests`,
        cookies: { rid: w.cookie },
      })
    ).json() as { id: string }[];
    expect(prs.map((p) => p.id)).toContain(prId);

    // Refreshing checks surfaces the failure and forwarding CI launches another session.
    const checks = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/pull-requests/${prId}/checks/refresh`,
      cookies: { rid: w.cookie },
    });
    expect(checks.statusCode).toBe(200);
    expect(checks.json().checksStatus).toBe("failure");

    const fix = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/pull-requests/${prId}/fix-ci`,
      cookies: { rid: w.cookie },
    });
    expect(fix.statusCode).toBe(202);
    expect(fix.json().sessionId).toBeTruthy();
  });

  it("returns 501 when GitHub is not configured (none provider)", async () => {
    const { app } = await startApp(new NoneGitHubProvider());
    const w = await seed(app);
    const sessionId = await launchAndFinish(app, w, "edit");

    const pr = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/pull-request`,
      cookies: { rid: w.cookie },
      payload: { title: "no provider" },
    });
    expect(pr.statusCode).toBe(501);
  });

  it("IDOR: another workspace cannot read a session's diff", async () => {
    const { app } = await startApp(new FakeGitHubProvider());
    const a = await seed(app);
    const b = await seed(app);
    const sessionId = await launchAndFinish(app, a, "edit");

    const res = await app.inject({
      method: "GET",
      url: `/channels/${a.channelId}/agent-sessions/${sessionId}/diff`,
      cookies: { rid: b.cookie }, // B's identity against A's channel
    });
    expect(res.statusCode).toBe(404);
  });
});
