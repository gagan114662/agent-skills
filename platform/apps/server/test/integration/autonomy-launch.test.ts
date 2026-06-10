import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { SessionManager } from "../../src/runtime/manager.js";
import type { SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { AutonomyEngine } from "../../src/autonomy/engine.js";
import { autonomyLauncherFrom } from "../../src/autonomy/default.js";
import { listAgentSessions } from "../../src/db/repositories/agent-sessions.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
} from "../../src/runtime/types.js";

/**
 * #84 — the autonomy engine launches REAL agent sessions and closes the loop.
 *
 * Wires the engine over a #25 SessionManager backed by a fake runtime (no cloud, no real harness),
 * so a `tick()` actually persists + drives a session row, and its terminal status feeds back into
 * the task: completed → done, non-zero exit → blocked. Proves autonomy executes work, not just
 * narration. Real Postgres + Redis (the SessionManager persists the session + streamed messages).
 */

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A runtime that emits one line and completes with the given exit code (0 = success). */
class CompletingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  constructor(private readonly exitCode: number) {}
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    hooks.onOutput("stdout", "autonomous work done\n");
    const exitCode = this.exitCode;
    return Promise.resolve<RunningSession>({
      sessionId: job.sessionId,
      wait: () =>
        Promise.resolve<RuntimeResult>({
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
        }),
      cancel: () => Promise.resolve(),
    });
  }
}

function makeEngine(exitCode: number): AutonomyEngine {
  const sessionManager = new SessionManager({
    runtime: new CompletingRuntime(exitCode),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["agent.sh"] },
    caps: { wallClockMs: 10_000, idleMs: 10_000 },
    logger: silentLogger,
  });
  return new AutonomyEngine({
    poster: channelPoster,
    logger: silentLogger,
    launcher: autonomyLauncherFrom(sessionManager),
  });
}

const slugs: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await Promise.allSettled(apps.map((a) => a.close()));
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  app: ReturnType<typeof buildApp>;
  engine: AutonomyEngine;
  cookie: string;
  workspaceId: string;
  channelId: string;
  researcher: string;
}

const post = (app: World["app"], url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "POST", url, cookies: { rid: cookie }, payload: payload as object });
const put = (app: World["app"], url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "PUT", url, cookies: { rid: cookie }, payload: payload as object });
const get = (app: World["app"], url: string, cookie: string) =>
  app.inject({ method: "GET", url, cookies: { rid: cookie } });

/** Sign up a human, make a channel, register + pool + enable autonomy for one researcher agent. */
async function seed(exitCode: number): Promise<World> {
  const engine = makeEngine(exitCode);
  const app = buildApp({ autonomyEngine: engine });
  apps.push(app);
  const slug = `aul-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get(app, "/me", cookie)).json();
  const channel = (
    await post(app, `/workspaces/${me.workspaceId}/channels`, cookie, { name: "team-a" })
  ).json();
  const researcher = (
    await post(app, `/workspaces/${me.workspaceId}/agents`, cookie, { name: "Researcher" })
  ).json();
  const pool = (
    await post(app, `/workspaces/${me.workspaceId}/agent-pools`, cookie, { name: `pool-${newId()}` })
  ).json();
  await post(app, `/workspaces/${me.workspaceId}/agent-pools/${pool.id}/agents`, cookie, {
    agentMemberId: researcher.memberId,
    roles: ["researcher"],
  });
  await put(app, `/workspaces/${me.workspaceId}/agents/${researcher.memberId}/autonomy`, cookie, {
    enabled: true,
    maxActionsPerTick: 5,
    actionBudget: 100,
  });
  return {
    app,
    engine,
    cookie,
    workspaceId: me.workspaceId,
    channelId: channel.id,
    researcher: researcher.memberId,
  };
}

async function createWorkflow(w: World, title: string): Promise<{ taskId: string; wfId: string }> {
  const taskId = (await post(w.app, `/workspaces/${w.workspaceId}/tasks`, w.cookie, { title })).json()
    .id as string;
  const wf = (
    await post(w.app, `/channels/${w.channelId}/workflows`, w.cookie, {
      taskId,
      stages: [{ agentMemberId: w.researcher, role: "researcher" }],
    })
  ).json();
  return { taskId, wfId: wf.id };
}

describe("autonomy engine launches real agent sessions (#84)", () => {
  it("tick → launch → complete → awaiting_approval → approve → done (the human gate closes it)", async () => {
    const w = await seed(0);
    const { taskId, wfId } = await createWorkflow(w, "summarize the repo");

    // tick: the engine decides `start` and launches a real session through the SessionManager.
    const tick = await w.engine.tick(w.workspaceId);
    expect(tick.actions.find((a) => a.workflowId === wfId)?.action).toBe("start");

    // A real agent session was persisted for the stage's agent (not just a channel post).
    const sessions = await listAgentSessions(w.channelId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentMemberId).toBe(w.researcher);

    // The task is in progress while the session runs.
    expect((await get(w.app, `/tasks/${taskId}`, w.cookie)).json().status).toBe("in_progress");

    // Let the session finish server-side. A successful run does NOT auto-complete the task — it
    // parks at the human approval gate (#13), exactly like the narration path.
    await w.engine.drain();

    expect((await get(w.app, `/tasks/${taskId}`, w.cookie)).json().status).toBe("in_progress");
    const parked = (await get(w.app, `/channels/${w.channelId}/workflows/${wfId}`, w.cookie)).json();
    expect(parked.status).toBe("awaiting_approval");
    const finished = await listAgentSessions(w.channelId);
    expect(finished[0].status).toBe("completed");

    const bodies = ((await get(w.app, `/channels/${w.channelId}/messages`, w.cookie)).json() as {
      body: string;
    }[]).map((m) => m.body);
    expect(bodies.some((b) => b.includes("launched agent session"))).toBe(true);
    expect(bodies.some((b) => b.includes("awaiting human approval"))).toBe(true);

    // A human approval closes the loop → task done, workflow completed.
    const pending = (
      await get(w.app, `/workspaces/${w.workspaceId}/autonomy/approvals?status=pending`, w.cookie)
    ).json() as { id: string }[];
    expect(pending).toHaveLength(1);
    const approve = await post(
      w.app,
      `/workspaces/${w.workspaceId}/autonomy/approvals/${pending[0].id}/approve`,
      w.cookie,
    );
    expect(approve.statusCode).toBe(200);

    expect((await get(w.app, `/tasks/${taskId}`, w.cookie)).json().status).toBe("done");
    expect(
      (await get(w.app, `/channels/${w.channelId}/workflows/${wfId}`, w.cookie)).json().status,
    ).toBe("completed");
  });

  it("tick → launch → complete → awaiting_approval → reject → blocked (rejection blocks the task)", async () => {
    const w = await seed(0);
    const { taskId, wfId } = await createWorkflow(w, "summarize the repo for review");

    await w.engine.tick(w.workspaceId);
    await w.engine.drain();
    expect(
      (await get(w.app, `/channels/${w.channelId}/workflows/${wfId}`, w.cookie)).json().status,
    ).toBe("awaiting_approval");

    const pending = (
      await get(w.app, `/workspaces/${w.workspaceId}/autonomy/approvals?status=pending`, w.cookie)
    ).json() as { id: string }[];
    const reject = await post(
      w.app,
      `/workspaces/${w.workspaceId}/autonomy/approvals/${pending[0].id}/reject`,
      w.cookie,
    );
    expect(reject.statusCode).toBe(200);

    // Rejection mirrors approval: the task is blocked for review and the workflow is canceled.
    expect((await get(w.app, `/tasks/${taskId}`, w.cookie)).json().status).toBe("blocked");
    expect(
      (await get(w.app, `/channels/${w.channelId}/workflows/${wfId}`, w.cookie)).json().status,
    ).toBe("canceled");
  });

  it("tick → launch → failure → task blocked (a failed session feeds back as blocked)", async () => {
    const w = await seed(1);
    const { taskId, wfId } = await createWorkflow(w, "do the risky thing");

    const tick = await w.engine.tick(w.workspaceId);
    expect(tick.actions.find((a) => a.workflowId === wfId)?.action).toBe("start");

    await w.engine.drain();

    expect((await get(w.app, `/tasks/${taskId}`, w.cookie)).json().status).toBe("blocked");
    const sessions = await listAgentSessions(w.channelId);
    expect(sessions[0].status).toBe("failed");
    const bodies = ((await get(w.app, `/channels/${w.channelId}/messages`, w.cookie)).json() as {
      body: string;
    }[]).map((m) => m.body);
    expect(bodies.some((b) => b.includes("blocked for review"))).toBe(true);
  });

  it("a workflow with a live session is skipped (admission: one session at a time)", async () => {
    // A pending runtime: the session only ends when cancelled, so it stays in flight across ticks.
    const sessionManager = new SessionManager({
      runtime: {
        kind: "local",
        start: (job: AgentJob) => {
          let resolve!: (r: RuntimeResult) => void;
          const done = new Promise<RuntimeResult>((r) => (resolve = r));
          return Promise.resolve<RunningSession>({
            sessionId: job.sessionId,
            wait: () => done,
            cancel: () => {
              resolve({ status: "canceled", exitCode: null });
              return Promise.resolve();
            },
          });
        },
      },
      store: dbStore,
      poster: channelPoster,
      secrets: new StaticSecretsResolver({}),
      harness: { command: "bash", args: ["agent.sh"] },
      caps: { wallClockMs: 10_000, idleMs: 10_000 },
      logger: silentLogger,
    });
    const engine = new AutonomyEngine({
      poster: channelPoster,
      logger: silentLogger,
      launcher: autonomyLauncherFrom(sessionManager),
    });
    const app = buildApp({ autonomyEngine: engine });
    apps.push(app);
    const slug = `aul-${newId()}`;
    slugs.push(slug);
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
    });
    const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
    const me = (await get(app, "/me", cookie)).json();
    const channel = (
      await post(app, `/workspaces/${me.workspaceId}/channels`, cookie, { name: "team-a" })
    ).json();
    const researcher = (
      await post(app, `/workspaces/${me.workspaceId}/agents`, cookie, { name: "Researcher" })
    ).json();
    const pool = (
      await post(app, `/workspaces/${me.workspaceId}/agent-pools`, cookie, { name: `pool-${newId()}` })
    ).json();
    await post(app, `/workspaces/${me.workspaceId}/agent-pools/${pool.id}/agents`, cookie, {
      agentMemberId: researcher.memberId,
      roles: ["researcher"],
    });
    await put(app, `/workspaces/${me.workspaceId}/agents/${researcher.memberId}/autonomy`, cookie, {
      enabled: true,
      maxActionsPerTick: 5,
      actionBudget: 100,
    });
    const taskId = (
      await post(app, `/workspaces/${me.workspaceId}/tasks`, cookie, { title: "long job" })
    ).json().id as string;
    const wf = (
      await post(app, `/channels/${channel.id}/workflows`, cookie, {
        taskId,
        stages: [{ agentMemberId: researcher.memberId, role: "researcher" }],
      })
    ).json();

    // tick 1 starts (launches) the still-running session.
    expect((await engine.tick(me.workspaceId)).actions[0]?.action).toBe("start");
    // tick 2: the session is in flight → the workflow is skipped, NOT escalated to approval.
    const second = await engine.tick(me.workspaceId);
    const action = second.actions.find((a) => a.workflowId === wf.id);
    expect(action?.action).toBe("noop");
    expect(action?.reason).toBe("session_running");

    await sessionManager.shutdown();
    await engine.drain();
  });
});
