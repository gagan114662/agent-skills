import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
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

/**
 * #70 local worktree isolation, end-to-end on real Postgres + LocalRuntime + a temp git repo (no
 * GitHub, no cloud). Proves the two Conductor-parity claims the unit tests can't reach through the
 * real session lifecycle:
 *   1/3. Two local sessions run concurrently on separate worktrees/branches; each session's edits land
 *        on ITS OWN branch only (no cross-branch leakage).
 *   2.   The wired reaper tears the worktrees down (and no orphan survives).
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A real host harness that writes its task (passed as AGENT_TASK) into a file in its worktree cwd. */
const WRITE_TASK_HARNESS = [
  "-e",
  "const fs=require('fs');" +
    "fs.writeFileSync('out.txt', process.env.AGENT_TASK + '\\n');" +
    "console.log('agent: wrote out.txt');",
];

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

function makeGitWorkspace(): GitWorkspaceService {
  const root = mkdtempSync(join(tmpdir(), "local-wt-it-"));
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

async function startApp(): Promise<{ app: FastifyInstance; gitWorkspace: GitWorkspaceService }> {
  const gitWorkspace = makeGitWorkspace();
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: WRITE_TASK_HARNESS },
    caps: { wallClockMs: 20_000, idleMs: 8_000 },
    logger: silentLogger,
    workspace: new GitWorkspaceProvisioner(gitWorkspace),
  });
  const app = buildApp({ sessionManager: manager, gitWorkspace, gitHubProvider: new NoneGitHubProvider() });
  apps.push(app);
  return { app, gitWorkspace };
}

interface World {
  cookie: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `lw-${newId()}`;
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
  return { cookie, channelId: channel.json().id, agentMemberId: agent.json().memberId };
}

async function launch(app: FastifyInstance, w: World, task: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/channels/${w.channelId}/agent-sessions`,
    cookies: { rid: w.cookie },
    payload: { agentMemberId: w.agentMemberId, task },
  });
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
}

async function waitDone(app: FastifyInstance, w: World, sessionId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const body = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions/${sessionId}`,
        cookies: { rid: w.cookie },
      })
    ).json();
    if (body.status === "completed" || body.status === "failed") {
      expect(body.status).toBe("completed");
      return;
    }
    if (Date.now() > deadline) throw new Error(`session ${sessionId} stuck in ${body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function diffPatch(app: FastifyInstance, w: World, sessionId: string): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: `/channels/${w.channelId}/agent-sessions/${sessionId}/diff?mode=cumulative`,
    cookies: { rid: w.cookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().branch).toBe(`agent/${sessionId}`);
  return res.json().patch as string;
}

describe("local worktree isolation (#70 — real Postgres, LocalRuntime, temp git repo)", () => {
  it("runs two sessions concurrently on isolated branches; each edit lands on its own branch only", async () => {
    const { app, gitWorkspace } = await startApp();
    const w = await seed(app);

    // Launch BOTH before waiting on either — they run concurrently on separate worktrees.
    const idA = await launch(app, w, "ALPHA-marker");
    const idB = await launch(app, w, "BETA-marker");
    expect(idA).not.toBe(idB);
    await Promise.all([waitDone(app, w, idA), waitDone(app, w, idB)]);

    // Distinct worktrees + branches.
    expect(gitWorkspace.worktreePathFor(idA)).not.toBe(gitWorkspace.worktreePathFor(idB));
    expect(existsSync(gitWorkspace.worktreePathFor(idA))).toBe(true);
    expect(existsSync(gitWorkspace.worktreePathFor(idB))).toBe(true);

    // Each session's edit is on ITS OWN branch only — no cross-branch leakage.
    const patchA = await diffPatch(app, w, idA);
    const patchB = await diffPatch(app, w, idB);
    expect(patchA).toContain("ALPHA-marker");
    expect(patchA).not.toContain("BETA-marker");
    expect(patchB).toContain("BETA-marker");
    expect(patchB).not.toContain("ALPHA-marker");

    // The wired reaper tears the worktrees down (nothing live → both reaped, no orphan survives).
    expect(app.gitWorktreeReaper).toBeTruthy();
    const { reaped } = await app.gitWorktreeReaper!.sweep();
    expect(reaped.sort()).toEqual([idA, idB].sort());
    expect(existsSync(gitWorkspace.worktreePathFor(idA))).toBe(false);
    expect(existsSync(gitWorkspace.worktreePathFor(idB))).toBe(false);
    expect(await gitWorkspace.listSessionWorktrees()).toEqual([]);
  });
});
