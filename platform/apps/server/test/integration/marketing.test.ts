import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { marketingTasks, workspacePlans, workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createMarketingTask } from "../../src/db/repositories/marketing-tasks.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { createScale } from "../../src/scale/default.js";

/**
 * #123 — Marketing Department Fleet (real Postgres + LocalRuntime).
 *
 * Proves the acceptance criteria end-to-end: a fresh workspace seeds the full agency (nine channels +
 * seven named agents), an @mention spawns a REAL harness session whose result threads back into the
 * channel and is recorded as a durable task, anything leaving the building is #13-gated (a social-post
 * draft is pending, never auto-sent), and the #71 kill switch halts a marketing launch.
 *
 * The harness is a cwd-independent `node -e` that echoes the AGENT_TASK it received, so the test can
 * assert the agent actually ran on the brief.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const AGENT_HARNESS = ["-e", "console.log('agent: task=' + (process.env.AGENT_TASK || 'none'));"];

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  // Wire the #71 admission chokepoint (kill switch / budget / concurrency) into the manager — and share
  // the SAME scale with the app — so the kill-switch test exercises the real launch gate.
  const scale = createScale(0);
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: AGENT_HARNESS },
    caps: { wallClockMs: 10_000, idleMs: 5_000 },
    logger: silentLogger,
    admission: scale.admission,
    usage: scale.usage,
  });
  app = buildApp({ sessionManager: manager, scale });
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `mkt-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function seed(owner: { cookie: string; workspaceId: string }) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/department/seed`,
    cookies: { rid: owner.cookie },
    payload: {},
  });
}

async function postMessage(owner: { cookie: string }, channelId: string, body: string) {
  return (
    await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      cookies: { rid: owner.cookie },
      payload: { body },
    })
  ).json();
}

async function waitForSession(owner: { cookie: string }, channelId: string, sessionId: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/agent-sessions/${sessionId}`,
      cookies: { rid: owner.cookie },
    });
    const status = res.json().status as string;
    if (["completed", "failed", "timeout", "idle_reaped", "canceled"].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("session did not finish in time");
}

async function threadReplies(owner: { cookie: string }, channelId: string, messageId: string) {
  const thread = (
    await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages/${messageId}/thread`,
      cookies: { rid: owner.cookie },
    })
  ).json();
  return thread.replies as Array<{ authorMemberId: string; body: string }>;
}

describe("#123 marketing department fleet (real Postgres)", () => {
  it("seeds ten channels and eight named agents that show up on the roster", async () => {
    const owner = await newOwner();
    const res = await seed(owner);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      channels: Array<{ id: string; name: string }>;
      agents: Array<{ handle: string; department: string }>;
    };
    expect(body.channels).toHaveLength(10);
    expect(body.agents.map((a) => a.handle).sort()).toEqual([
      "bid",
      "comet",
      "echo",
      "lens",
      "mark",
      "postmark",
      "quill",
      "scout",
    ]);

    const roster = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/department/roster`,
        cookies: { rid: owner.cookie },
      })
    ).json() as { humans: unknown[]; agents: Array<{ handle: string; present: boolean }> };
    expect(roster.humans).toHaveLength(1);
    expect(roster.agents).toHaveLength(8);
    expect(roster.agents.every((a) => a.present === false)).toBe(true);

    // Idempotent: re-seeding returns the same agency, not duplicates.
    const again = await seed(owner);
    expect(again.statusCode).toBe(201);
    expect(again.json().channels).toHaveLength(10);
  });

  it("@mentions an agent from a plain message post → spawns a real session, threads the result, records a task", async () => {
    // The real prod path (regression for the @scout incident): a department agent @mentioned in its
    // channel must spawn a session purely from `POST /channels/:cid/messages` — what the web client does.
    // Before the fix the launch only ran via the standalone `/marketing` endpoint that nothing called, so
    // sessionsStarted stayed 0 and the owner saw no response. NOTE: no explicit `/marketing` call here.
    const owner = await newOwner();
    const seo = (await seed(owner)).json().channels.find((c: { name: string }) => c.name === "seo");

    const msg = await postMessage(owner, seo.id, "@scout audit https://ipop.ai and tell me where it trips");

    // The post-time trigger records the mention task asynchronously; poll for it + its session id.
    let sessionId: string | undefined;
    for (let i = 0; i < 80 && !sessionId; i++) {
      const tasks = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${owner.workspaceId}/department/tasks`,
          cookies: { rid: owner.cookie },
        })
      ).json() as Array<{ kind: string; department: string; sessionId: string | null }>;
      const t = tasks.find((t) => t.kind === "mention" && t.department === "seo" && t.sessionId);
      if (t) sessionId = t.sessionId!;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(sessionId, "post-time trigger should have launched a session").toBeDefined();

    expect(await waitForSession(owner, seo.id, sessionId!)).toBe("completed");

    // The agent actually ran on the brief and threaded its result back under the @mention.
    const replies = await threadReplies(owner, seo.id, msg.id);
    expect(replies.map((r) => r.body).join("\n")).toContain(
      "agent: task=@scout audit https://ipop.ai and tell me where it trips",
    );
  });

  it("does not auto-launch on a plain post that mentions no department agent", async () => {
    // The trigger fires only when a department persona is actually @mentioned — an ordinary message in a
    // department channel must not spawn a session. (Agent-authored posts can't trigger it either: they go
    // through channelPoster, which never runs the fan-out, and the trigger is human-only regardless.)
    const owner = await newOwner();
    const seo = (await seed(owner)).json().channels.find((c: { name: string }) => c.name === "seo");
    await postMessage(owner, seo.id, "just a note, nobody mentioned");
    await new Promise((r) => setTimeout(r, 400));
    const tasks = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/department/tasks`,
        cookies: { rid: owner.cookie },
      })
    ).json() as Array<{ kind: string }>;
    expect(tasks.some((t) => t.kind === "mention")).toBe(false);
  });

  it("ships a non-paid social post autonomously but gates real ad spend (#243 money-only)", async () => {
    const owner = await newOwner();
    await seed(owner);
    // A non-paid social post leaves the building on its own — no owner prompt (#243).
    const post = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      cookies: { rid: owner.cookie },
      payload: {
        actionType: "external.send",
        payload: { kind: "social.post", summary: "Launch day thread", target: "x" },
      },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json().status).toBe("executed");

    // Real ad spend (money) still pauses for the owner, with the exact amount on the request.
    const spend = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      cookies: { rid: owner.cookie },
      payload: {
        actionType: "external.send",
        amount: 5000,
        payload: { kind: "ad.spend", summary: "Google Ads starter", amountCents: 5000 },
      },
    });
    expect(spend.statusCode).toBe(202);
    expect(spend.json().status).toBe("pending");
    expect(spend.json().request.amount).toBe(5000);
  });

  // #235: the owner BRIEFS a lead from the dashboard composer → a REAL session spawns and the board fills.
  it("owner briefs a lead → posts the goal, launches a real session, threads the agent's work back", async () => {
    const owner = await newOwner();
    const seed1 = (await seed(owner)).json();
    const seo = seed1.channels.find((c: { name: string }) => c.name === "seo");

    const goal = "go get us our first paying founders for ipop.ai";
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/department/brief`,
      cookies: { rid: owner.cookie },
      payload: { lead: "scout", goal },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      lead: string;
      department: string;
      channelId: string;
      messageId: string;
      launched: Array<{ handle: string; sessionId: string }>;
      connectPrompted: unknown[];
    };
    expect(body.lead).toBe("scout");
    expect(body.department).toBe("seo");
    expect(body.channelId).toBe(seo.id);
    // A REAL session spawned synchronously — this is the row the board's "Work in progress" lane renders.
    expect(body.launched).toHaveLength(1);
    expect(body.launched[0]!.handle).toBe("scout");
    const sessionId = body.launched[0]!.sessionId;

    // The board fills: mission control reports the live session for the workspace (WIP >= 1).
    const mc = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/mission-control`,
        cookies: { rid: owner.cookie },
      })
    ).json() as { sessions: Array<{ id: string }> };
    expect(mc.sessions.length).toBeGreaterThanOrEqual(1);

    // The brief was posted into #seo AS the owner, @mentioning the lead (the working control, not chrome).
    const messages = (
      await app.inject({
        method: "GET",
        url: `/channels/${seo.id}/messages`,
        cookies: { rid: owner.cookie },
      })
    ).json() as Array<{ authorMemberId: string; body: string }>;
    const brief = messages.find((m) => m.body === `@scout ${goal}`);
    expect(brief, "the brief is posted with the @mention").toBeDefined();
    expect(brief!.authorMemberId).toBe(owner.memberId);

    // The agent actually ran on the goal and threaded its work back under the brief.
    expect(await waitForSession(owner, seo.id, sessionId)).toBe("completed");
    const replies = await threadReplies(owner, seo.id, body.messageId);
    expect(replies.map((r) => r.body).join("\n")).toContain(`agent: task=${goal}`);
  });

  it("trims the department task history to the active plan's dashboard history window (#1290)", async () => {
    const owner = await newOwner();
    const seedResult = (await seed(owner)).json() as {
      channels: Array<{ id: string; name: string }>;
      agents: Array<{ handle: string; department: string; agentMemberId: string }>;
    };
    const seo = seedResult.channels.find((c) => c.name === "seo")!;
    const scout = seedResult.agents.find((a) => a.handle === "scout")!;
    const recentGoal = "ship the pricing proof update";
    const oldGoal = "audit the old launch copy";
    await createMarketingTask({
      workspaceId: owner.workspaceId,
      channelId: seo.id,
      department: "seo",
      agentMemberId: scout.agentMemberId,
      kind: "mention",
      task: recentGoal,
      createdByMemberId: owner.memberId,
    });
    await createMarketingTask({
      workspaceId: owner.workspaceId,
      channelId: seo.id,
      department: "seo",
      agentMemberId: scout.agentMemberId,
      kind: "mention",
      task: oldGoal,
      createdByMemberId: owner.memberId,
    });
    await db.insert(workspacePlans).values({
      workspaceId: owner.workspaceId,
      planKey: "starter",
      status: "active",
      agentSeats: 3,
      monthlySessionBudgetCents: 20_000,
      fleetSize: 1,
      providerEventId: "test-history-window",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      nextBillingAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      renewalStatus: "active",
    });
    await db
      .update(marketingTasks)
      .set({
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      })
      .where(and(eq(marketingTasks.workspaceId, owner.workspaceId), eq(marketingTasks.task, oldGoal)));

    const feed = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/department/tasks`,
      cookies: { rid: owner.cookie },
    });
    expect(feed.statusCode).toBe(200);
    const tasks = feed.json() as Array<{ task: string }>;
    expect(tasks.some((task) => task.task === recentGoal)).toBe(true);
    expect(tasks.some((task) => task.task === oldGoal)).toBe(false);
  });

  it("rejects a brief with an unknown lead (400) or a goal-less brief (400), launching nothing", async () => {
    const owner = await newOwner();
    await seed(owner);
    const unknown = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/department/brief`,
      cookies: { rid: owner.cookie },
      payload: { lead: "nobody", goal: "do a thing" },
    });
    expect(unknown.statusCode).toBe(400);
    const empty = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/department/brief`,
      cookies: { rid: owner.cookie },
      payload: { lead: "scout", goal: "   " },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("halts a brief when the kill switch is engaged (#71 admission — the brief reuses the audited path)", async () => {
    const owner = await newOwner();
    await seed(owner);
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/autonomy/kill`,
      cookies: { rid: owner.cookie },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/department/brief`,
      cookies: { rid: owner.cookie },
      payload: { lead: "scout", goal: "rank us for AI marketing agency" },
    });
    expect(res.statusCode).toBe(429);
  });

  it("halts a marketing launch when the kill switch is engaged (#71 admission)", async () => {
    const owner = await newOwner();
    const social = (await seed(owner)).json().channels.find((c: { name: string }) => c.name === "social");

    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/autonomy/kill`,
      cookies: { rid: owner.cookie },
    });

    const msg = await postMessage(owner, social.id, "@echo draft a launch thread");
    const launch = await app.inject({
      method: "POST",
      url: `/channels/${social.id}/messages/${msg.id}/marketing`,
      cookies: { rid: owner.cookie },
      payload: {},
    });
    expect(launch.statusCode).toBe(429);
  });
});
