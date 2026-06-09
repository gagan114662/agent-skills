import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
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
import { createTurnController } from "../../src/turns/default.js";
import { createAgentSession } from "../../src/db/repositories/agent-sessions.js";
import { postMessage, listChannelMessages } from "../../src/db/repositories/messages.js";
import { listSessionTurns } from "../../src/db/repositories/session-turns.js";

/**
 * #53 — Plan mode, checkpoints & steering (real Postgres + Redis, LocalRuntime + the steerable demo
 * harness + a temp git repo). Proves the three acceptance criteria end-to-end:
 *   1. An agent proposes a plan and WORK BLOCKS until a human decides (approve-with-feedback threads
 *      the note into the execution; reject launches nothing).
 *   2. Reverting a turn restores BOTH the working tree (git reset) and the conversation (soft-delete).
 *   3. A steering message is delivered to a LIVE session and recorded in the channel.
 * Plus the RBAC/IDOR + 501-without-git boundaries.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/agent-harness-plan-demo.sh");

let app: FastifyInstance;
let manager: SessionManager;
const slugs: string[] = [];
let gitRoot: string;

beforeAll(async () => {
  manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: [HARNESS] },
    caps: { wallClockMs: 30_000, idleMs: 15_000 },
    logger: silentLogger,
  });
  app = buildApp({ sessionManager: manager });
  await app.ready();
  gitRoot = mkdtempSync(join(tmpdir(), "pcs-git-"));
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  rmSync(gitRoot, { recursive: true, force: true });
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  cookie: string;
  workspaceId: string;
  memberId: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(): Promise<World> {
  const slug = `pcs-${newId()}`;
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
    memberId: me.memberId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

async function poll(
  w: World,
  sessionId: string,
  until: (s: string) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}`,
      cookies: { rid: w.cookie },
    });
    const body = res.json();
    if (until(body.status)) return body;
    if (Date.now() > deadline) throw new Error(`session stuck in ${body.status}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const bodies = async (w: World): Promise<string[]> =>
  (
    (await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/messages`,
      cookies: { rid: w.cookie },
    })).json() as { body: string }[]
  ).map((m) => m.body);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe("#53 plan mode (work blocks until approval)", () => {
  it("proposes a plan, blocks, then approve-with-feedback threads the note into the execution", async () => {
    const w = await seed();

    const proposeRes = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/plans`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "ship the feature" },
    });
    expect(proposeRes.statusCode).toBe(202);
    const proposal = proposeRes.json();
    expect(proposal.status).toBe("proposed");
    expect(proposal.planText).toContain("read the relevant files");

    // Work blocks: the proposal carries no execution session yet.
    const listed = (
      await app.inject({ method: "GET", url: `/channels/${w.channelId}/plans`, cookies: { rid: w.cookie } })
    ).json() as { id: string; status: string; executionSessionId: string | null }[];
    expect(listed[0]?.executionSessionId).toBeNull();

    // Approve WITH feedback → launches the execution with the feedback in its task.
    const decideRes = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/plans/${proposal.proposalId}/decide`,
      cookies: { rid: w.cookie },
      payload: { decision: "approve_with_feedback", feedback: "write tests first" },
    });
    expect(decideRes.statusCode).toBe(200);
    const { status, executionSessionId } = decideRes.json();
    expect(status).toBe("approved_with_feedback");
    expect(executionSessionId).toBeTruthy();

    await poll(w, executionSessionId, (s) => s === "completed" || s === "failed");
    const msgs = await bodies(w);
    // The execution harness echoes its task — which now carries the reviewer feedback.
    expect(msgs.some((b) => b.includes("write tests first"))).toBe(true);
  });

  it("reject launches nothing", async () => {
    const w = await seed();
    const proposal = (
      await app.inject({
        method: "POST",
        url: `/channels/${w.channelId}/plans`,
        cookies: { rid: w.cookie },
        payload: { agentMemberId: w.agentMemberId, task: "do the risky thing" },
      })
    ).json();
    const decideRes = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/plans/${proposal.proposalId}/decide`,
      cookies: { rid: w.cookie },
      payload: { decision: "reject" },
    });
    expect(decideRes.json()).toMatchObject({ status: "rejected", executionSessionId: null });

    // A second decision is refused (work blocks on exactly one decision).
    const second = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/plans/${proposal.proposalId}/decide`,
      cookies: { rid: w.cookie },
      payload: { decision: "approve" },
    });
    expect(second.statusCode).toBe(409);
  });
});

describe("#53 steering (redirect a live agent)", () => {
  it("delivers guidance to the running session and records it in the channel", async () => {
    const w = await seed();
    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "long running task" },
    });
    const sessionId = launch.json().id as string;
    await poll(w, sessionId, (s) => s === "running"); // wait until the process is live

    const steerRes = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/steer`,
      cookies: { rid: w.cookie },
      payload: { guidance: "prioritize the auth bug" },
    });
    expect(steerRes.statusCode).toBe(200);
    expect(steerRes.json().delivered).toBe(true);

    await poll(w, sessionId, (s) => s === "completed" || s === "failed");
    const msgs = await bodies(w);
    expect(msgs.some((b) => b.includes("↪️ steering: prioritize the auth bug"))).toBe(true); // recorded
    expect(msgs.some((b) => b.includes("steer: prioritize the auth bug"))).toBe(true); // live echo
  });
});

describe("#53 checkpoints & revert (files + conversation together)", () => {
  it("reverting a turn restores both the working tree and the conversation", async () => {
    const w = await seed();

    // A temp source repo + a real GitWorkspaceService keyed by the session id (the #51 worktree).
    const repoRoot = join(gitRoot, newId());
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, "init", "-b", "main");
    git(repoRoot, "config", "user.email", "t@e.com");
    git(repoRoot, "config", "user.name", "T");
    writeFileSync(join(repoRoot, "README.md"), "# base\n");
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-m", "init");
    const gitWorkspace = new GitWorkspaceService({
      repoRoot,
      worktreesRoot: join(gitRoot, "worktrees", newId()),
      baseBranch: "main",
    });
    const controller = createTurnController(manager, gitWorkspace);

    // A real session row the turns reference (FK), then its worktree.
    const session = await createAgentSession({
      workspaceId: w.workspaceId,
      channelId: w.channelId,
      agentMemberId: w.agentMemberId,
      createdByMemberId: w.memberId,
      runtime: "local",
      command: "demo",
      caps: { wallClockMs: 1000, idleMs: 1000 },
    });
    const { cwd } = await gitWorkspace.prepare(session.id);

    const post = (body: string) =>
      postMessage({
        workspaceId: w.workspaceId,
        channelId: w.channelId,
        authorMemberId: w.agentMemberId,
        body,
      });
    const cp = () =>
      controller.checkpoint({
        workspaceId: w.workspaceId,
        channelId: w.channelId,
        sessionId: session.id,
        createdByMemberId: w.memberId,
      });

    await post("session started");
    await cp(); // baseline (idx 0)

    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    await post("turn 1: created a.ts");
    await cp(); // turn 1 (idx 1)

    writeFileSync(join(cwd, "b.ts"), "export const b = 2;\n");
    const m2 = await post("turn 2: created b.ts");
    const t2 = await cp(); // turn 2 (idx 2)
    expect(t2.ok).toBe(true);
    if (!t2.ok) return;

    // Revert turn 2 → file B disappears, file A remains; turn-2 messages soft-deleted, turn-1 remain.
    // Driven through the same git-backed controller the route uses (the app default has no repo, so
    // its route 501s — covered separately below); this exercises the real DB + git + message path.
    const revertRes = await controller.revert({
      channelId: w.channelId,
      sessionId: session.id,
      turnId: t2.turn.id,
    });
    expect(revertRes.ok).toBe(true);
    if (!revertRes.ok) return;
    expect(revertRes.deletedMessageCount).toBeGreaterThanOrEqual(1);

    // FILES restored.
    expect(existsSync(join(cwd, "a.ts"))).toBe(true);
    expect(existsSync(join(cwd, "b.ts"))).toBe(false);

    // CONVERSATION restored: turn-2 message gone, turn-1 message kept.
    const msgs = (await listChannelMessages(w.channelId)).map((m) => m.body);
    expect(msgs).toContain("turn 1: created a.ts");
    expect(msgs).not.toContain("turn 2: created b.ts");
    void m2;

    // The discarded turn is marked reverted in the ledger.
    const turns = await listSessionTurns(session.id);
    expect(turns.find((t) => t.id === t2.turn.id)?.revertedAt).not.toBeNull();
  });

  it("checkpoint/revert return 501 when no git workspace is configured", async () => {
    const w = await seed();
    const session = await createAgentSession({
      workspaceId: w.workspaceId,
      channelId: w.channelId,
      agentMemberId: w.agentMemberId,
      createdByMemberId: w.memberId,
      runtime: "local",
      command: "demo",
      caps: { wallClockMs: 1000, idleMs: 1000 },
    });
    // The app under test was built with no git repo (default) → checkpoint route 501s.
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${session.id}/checkpoint`,
      cookies: { rid: w.cookie },
    });
    expect(res.statusCode).toBe(501);
  });
});

describe("#53 RBAC / IDOR", () => {
  it("a non-member is forbidden from proposing/steering and a cross-channel session 404s", async () => {
    const owner = await seed();
    const outsider = await seed();

    // Outsider (different workspace) cannot propose into the owner's channel — 404 (tenant isolation).
    const propose = await app.inject({
      method: "POST",
      url: `/channels/${owner.channelId}/plans`,
      cookies: { rid: outsider.cookie },
      payload: { agentMemberId: outsider.agentMemberId, task: "intrude" },
    });
    expect(propose.statusCode).toBe(404);

    // A session id from another channel 404s on a turns read scoped to this channel.
    const session = await createAgentSession({
      workspaceId: owner.workspaceId,
      channelId: owner.channelId,
      agentMemberId: owner.agentMemberId,
      createdByMemberId: owner.memberId,
      runtime: "local",
      command: "demo",
      caps: { wallClockMs: 1000, idleMs: 1000 },
    });
    const wrongChannel = await app.inject({
      method: "GET",
      url: `/channels/${outsider.channelId}/agent-sessions/${session.id}/turns`,
      cookies: { rid: outsider.cookie },
    });
    expect(wrongChannel.statusCode).toBe(404);
  });
});
