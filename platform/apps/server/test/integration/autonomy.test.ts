import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { channelPoster } from "../../src/runtime/default.js";
import { AutonomyEngine } from "../../src/autonomy/engine.js";
import {
  getAutonomy,
  refundActionsUsed,
  tryReserveActionsUsed,
} from "../../src/db/repositories/autonomy.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

/** A no-op logger so the engine's logging doesn't spam the test output. */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// One app + engine, shared across cases; each case seeds its own workspace (tenant-isolated).
const engine = new AutonomyEngine({ poster: channelPoster, logger: silentLogger });
const app = buildApp({ autonomyEngine: engine });
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  engine.stop();
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  cookie: string;
  workspaceId: string;
  humanMemberId: string;
  channelId: string;
  researcher: string;
  writer: string;
}

const post = (url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "POST", url, cookies: { rid: cookie }, payload: payload as object });
const put = (url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "PUT", url, cookies: { rid: cookie }, payload: payload as object });
const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, cookies: { rid: cookie } });

/** Sign up a human in a fresh workspace, make a channel ("team-a"), register two agents. */
async function seed(channelName = "team-a"): Promise<World> {
  const slug = `au-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get("/me", cookie)).json();
  const channel = (
    await post(`/workspaces/${me.workspaceId}/channels`, cookie, { name: channelName })
  ).json();
  const researcher = (
    await post(`/workspaces/${me.workspaceId}/agents`, cookie, { name: "Researcher" })
  ).json();
  const writer = (
    await post(`/workspaces/${me.workspaceId}/agents`, cookie, { name: "Writer" })
  ).json();
  return {
    cookie,
    workspaceId: me.workspaceId,
    humanMemberId: me.memberId,
    channelId: channel.id,
    researcher: researcher.memberId,
    writer: writer.memberId,
  };
}

/** Pool the given agents (with roles) and enable autonomy for each. Returns the pool id. */
async function poolAndEnable(
  w: World,
  agents: { memberId: string; roles: string[] }[],
  autonomy: { maxActionsPerTick?: number; actionBudget?: number } = {},
): Promise<string> {
  const pool = (
    await post(`/workspaces/${w.workspaceId}/agent-pools`, w.cookie, { name: `pool-${newId()}` })
  ).json();
  for (const a of agents) {
    await post(`/workspaces/${w.workspaceId}/agent-pools/${pool.id}/agents`, w.cookie, {
      agentMemberId: a.memberId,
      roles: a.roles,
    });
    await put(`/workspaces/${w.workspaceId}/agents/${a.memberId}/autonomy`, w.cookie, {
      enabled: true,
      maxActionsPerTick: autonomy.maxActionsPerTick ?? 5,
      actionBudget: autonomy.actionBudget ?? 100,
    });
  }
  return pool.id;
}

async function createTask(w: World, title: string): Promise<string> {
  const res = await post(`/workspaces/${w.workspaceId}/tasks`, w.cookie, { title });
  return res.json().id as string;
}

async function bodies(w: World, channelId = w.channelId): Promise<string[]> {
  const msgs = (await get(`/channels/${channelId}/messages`, w.cookie)).json() as {
    body: string;
    authorMemberId: string;
  }[];
  return msgs.map((m) => m.body);
}

describe("cross-team agent pooling + autonomy loop (real Postgres + Redis, #17)", () => {
  it("atomically reserves action budget under concurrent ticks", async () => {
    const w = await seed();
    await poolAndEnable(w, [{ memberId: w.researcher, roles: ["researcher"] }], {
      maxActionsPerTick: 5,
      actionBudget: 2,
    });
    const autonomy = await getAutonomy(w.workspaceId, w.researcher);
    expect(autonomy).toBeTruthy();

    const results = await Promise.all([
      tryReserveActionsUsed(autonomy!.id),
      tryReserveActionsUsed(autonomy!.id),
      tryReserveActionsUsed(autonomy!.id),
    ]);

    expect(results).toEqual(expect.arrayContaining([true, true, false]));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect((await getAutonomy(w.workspaceId, w.researcher))!.actionsUsed).toBe(2);

    await refundActionsUsed(autonomy!.id);
    expect((await getAutonomy(w.workspaceId, w.researcher))!.actionsUsed).toBe(1);
  });

  it("AC1: an agent progresses an assigned task without human prompting", async () => {
    const w = await seed();
    await poolAndEnable(w, [{ memberId: w.researcher, roles: ["researcher"] }]);
    const taskId = await createTask(w, "summarize the repo");
    const wf = (
      await post(`/channels/${w.channelId}/workflows`, w.cookie, {
        taskId,
        stages: [{ agentMemberId: w.researcher, role: "researcher" }],
      })
    ).json();
    expect(wf.status).toBe("running");

    // No human prompt — the loop alone advances the task.
    const tick = await engine.tick(w.workspaceId);
    expect(tick.actions.find((a) => a.workflowId === wf.id)?.action).toBe("start");

    const task = (await get(`/tasks/${taskId}`, w.cookie)).json();
    expect(task.status).toBe("in_progress");
    expect((await bodies(w)).some((b) => b.includes("picked up task"))).toBe(true);
  });

  it("AC2: a two-agent handoff completes a workflow, pausing only at approval (A2A shared memory)", async () => {
    const w = await seed();
    await poolAndEnable(w, [
      { memberId: w.researcher, roles: ["researcher"] },
      { memberId: w.writer, roles: ["writer"] },
    ]);
    const taskId = await createTask(w, "write the launch post");
    const wf = (
      await post(`/channels/${w.channelId}/workflows`, w.cookie, {
        taskId,
        stages: [
          { agentMemberId: w.researcher, role: "researcher" },
          { agentMemberId: w.writer, role: "writer" },
        ],
      })
    ).json();

    // tick 1: researcher starts.   tick 2: researcher hands off to writer.   tick 3: writer asks approval.
    expect((await engine.tick(w.workspaceId)).actions[0]?.action).toBe("start");
    expect((await engine.tick(w.workspaceId)).actions[0]?.action).toBe("handoff");
    expect((await engine.tick(w.workspaceId)).actions[0]?.action).toBe("request_approval");

    // The workflow parked at the human gate; the task is reassigned to the writer; continuity rode
    // in shared memory linked to the task (#16/#14).
    const parked = (await get(`/channels/${w.channelId}/workflows/${wf.id}`, w.cookie)).json();
    expect(parked.status).toBe("awaiting_approval");
    expect(parked.currentStage).toBe(1);
    const assigned = (await get(`/tasks/${taskId}`, w.cookie)).json();
    expect(assigned.assigneeMemberId).toBe(w.writer);
    const links = (await get(`/tasks/${taskId}/links`, w.cookie)).json() as { targetType: string }[];
    expect(links.some((l) => l.targetType === "memory")).toBe(true);

    const text = (await bodies(w)).join("\n");
    expect(text).toContain("handoff");
    expect(text).toContain("continuity saved to shared memory");
    expect(text).toContain("awaiting human approval");

    // Ticking again changes nothing — parked at awaiting_approval, it is out of the active loop
    // entirely and only a human moves it.
    await engine.tick(w.workspaceId);
    const stillParked = (await get(`/channels/${w.channelId}/workflows/${wf.id}`, w.cookie)).json();
    expect(stillParked.status).toBe("awaiting_approval");
    expect(stillParked.currentStage).toBe(1);

    // A single human approval completes the whole workflow.
    const pending = (await get(`/workspaces/${w.workspaceId}/autonomy/approvals?status=pending`, w.cookie)).json();
    expect(pending).toHaveLength(1);
    const approve = await post(
      `/workspaces/${w.workspaceId}/autonomy/approvals/${pending[0].id}/approve`,
      w.cookie,
    );
    expect(approve.statusCode).toBe(200);

    const done = (await get(`/channels/${w.channelId}/workflows/${wf.id}`, w.cookie)).json();
    expect(done.status).toBe("completed");
    const finalTask = (await get(`/tasks/${taskId}`, w.cookie)).json();
    expect(finalTask.status).toBe("done");
    expect((await bodies(w)).some((b) => b.includes("approved & completed"))).toBe(true);
  });

  it("AC3: a shared (pooled) agent acts in a second team per its roles", async () => {
    const w = await seed("team-a");
    // The writer is pooled in the workspace (shareable). Stand up a second team (channel).
    await poolAndEnable(w, [{ memberId: w.writer, roles: ["writer"] }]);
    const teamB = (
      await post(`/workspaces/${w.workspaceId}/channels`, w.cookie, { name: "team-b" })
    ).json();

    // Explicitly share the pooled agent into team B (grants membership + #9 write there).
    const share = await post(`/channels/${teamB.id}/share-agent`, w.cookie, {
      agentMemberId: w.writer,
    });
    expect(share.statusCode).toBe(201);
    expect(share.json().roles).toContain("writer");

    // A workflow in team B run by the shared agent — it acts in the second team.
    const taskId = await createTask(w, "draft team-b note");
    const wf = (
      await post(`/channels/${teamB.id}/workflows`, w.cookie, {
        taskId,
        stages: [{ agentMemberId: w.writer, role: "writer" }],
      })
    ).json();
    await engine.tick(w.workspaceId);

    const msgs = (await get(`/channels/${teamB.id}/messages`, w.cookie)).json() as {
      body: string;
      authorMemberId: string;
    }[];
    const acted = msgs.find((m) => m.body.includes("picked up task"));
    expect(acted).toBeDefined();
    expect(acted!.authorMemberId).toBe(w.writer); // the shared agent itself acted in team B
    expect(wf.channelId).toBe(teamB.id);

    // Sharing requires pool membership: a non-pooled agent (the researcher) cannot be shared.
    const denied = await post(`/channels/${teamB.id}/share-agent`, w.cookie, {
      agentMemberId: w.researcher,
    });
    expect(denied.statusCode).toBe(400);
  });

  it("AC4: kill switch halts immediately and the budget/loop guards stop runaway actions", async () => {
    const w = await seed();
    // Budget guard: researcher gets a budget of exactly 1 action.
    await poolAndEnable(
      w,
      [
        { memberId: w.researcher, roles: ["researcher"] },
        { memberId: w.writer, roles: ["writer"] },
      ],
      { actionBudget: 1 },
    );

    // --- kill switch: engage BEFORE the first tick → zero actions, task untouched. ---
    const killTaskId = await createTask(w, "should not start under kill switch");
    await post(`/channels/${w.channelId}/workflows`, w.cookie, {
      taskId: killTaskId,
      stages: [{ agentMemberId: w.researcher, role: "researcher" }],
    });
    const kill = await post(`/workspaces/${w.workspaceId}/autonomy/kill`, w.cookie);
    expect(kill.json().killSwitch).toBe(true);
    const haltedTick = await engine.tick(w.workspaceId);
    expect(haltedTick.killSwitch).toBe(true);
    expect(haltedTick.actions).toHaveLength(0);
    expect((await get(`/tasks/${killTaskId}`, w.cookie)).json().status).toBe("backlog");
    // No autonomous narration happened at all.
    expect((await bodies(w)).some((b) => b.includes("picked up task"))).toBe(false);

    // --- resume + budget guard: 1-action budget means the workflow stalls after its start. ---
    await post(`/workspaces/${w.workspaceId}/autonomy/resume`, w.cookie);
    const budgetTaskId = await createTask(w, "budget-capped work");
    await post(`/channels/${w.channelId}/workflows`, w.cookie, {
      taskId: budgetTaskId,
      stages: [
        { agentMemberId: w.researcher, role: "researcher" },
        { agentMemberId: w.writer, role: "writer" },
      ],
    });
    // tick 1 spends the researcher's only budgeted action (start).
    const t1 = await engine.tick(w.workspaceId);
    expect(t1.actions.find((a) => a.action === "start")).toBeDefined();
    // tick 2: budget exhausted → no handoff, the loop is bounded.
    const t2 = await engine.tick(w.workspaceId);
    const budgetWf = t2.actions.find((a) => a.reason === "budget_exhausted");
    expect(budgetWf).toBeDefined();
    expect(budgetWf!.action).toBe("noop");

    // --- loop guard: a fresh, un-budget-capped world; an engine with a zero ceiling refuses to
    // act on the workflow (its agent has budget to spare, so loop_guard is the reason that wins). ---
    const wLoop = await seed();
    await poolAndEnable(wLoop, [{ memberId: wLoop.researcher, roles: ["researcher"] }]);
    const loopTaskId = await createTask(wLoop, "would loop forever");
    await post(`/channels/${wLoop.channelId}/workflows`, wLoop.cookie, {
      taskId: loopTaskId,
      stages: [{ agentMemberId: wLoop.researcher, role: "researcher" }],
    });
    const loopGuarded = new AutonomyEngine({
      poster: channelPoster,
      logger: silentLogger,
      loopGuardMax: 0,
    });
    const guarded = await loopGuarded.tick(wLoop.workspaceId);
    expect(guarded.actions.every((a) => a.action === "noop")).toBe(true);
    expect(guarded.actions.some((a) => a.reason === "loop_guard")).toBe(true);
  });

  it("IDOR: a workspace cannot drive or kill another workspace's autonomy", async () => {
    const a = await seed();
    const b = await seed();
    // B's human aims B's cookie at A's workspace controls.
    const kill = await post(`/workspaces/${a.workspaceId}/autonomy/kill`, b.cookie);
    expect(kill.statusCode).toBe(403);
    const tick = await post(`/workspaces/${a.workspaceId}/autonomy/tick`, b.cookie);
    expect(tick.statusCode).toBe(403);
  });
});
