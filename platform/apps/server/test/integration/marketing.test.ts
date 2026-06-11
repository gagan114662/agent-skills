import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
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
  it("seeds nine channels and seven named agents that show up on the roster", async () => {
    const owner = await newOwner();
    const res = await seed(owner);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      channels: Array<{ id: string; name: string }>;
      agents: Array<{ handle: string; department: string }>;
    };
    expect(body.channels).toHaveLength(9);
    expect(body.agents.map((a) => a.handle).sort()).toEqual([
      "bid",
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
    expect(roster.agents).toHaveLength(7);
    expect(roster.agents.every((a) => a.present === false)).toBe(true);

    // Idempotent: re-seeding returns the same agency, not duplicates.
    const again = await seed(owner);
    expect(again.statusCode).toBe(201);
    expect(again.json().channels).toHaveLength(9);
  });

  it("@mentions an agent → spawns a real session, threads the result, and records a task", async () => {
    const owner = await newOwner();
    const seo = (await seed(owner)).json().channels.find((c: { name: string }) => c.name === "seo");

    const msg = await postMessage(owner, seo.id, "@scout audit our landing page");
    const launch = await app.inject({
      method: "POST",
      url: `/channels/${seo.id}/messages/${msg.id}/marketing`,
      cookies: { rid: owner.cookie },
      payload: {},
    });
    expect(launch.statusCode).toBe(202);
    const launched = launch.json().launched as Array<{ handle: string; sessionId: string; taskId: string }>;
    expect(launched).toHaveLength(1);
    expect(launched[0].handle).toBe("scout");

    expect(await waitForSession(owner, seo.id, launched[0].sessionId)).toBe("completed");

    const replies = await threadReplies(owner, seo.id, msg.id);
    const text = replies.map((r) => r.body).join("\n");
    expect(text).toContain("agent: task=@scout audit our landing page");

    // A durable task record exists for the mention.
    const tasks = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/department/tasks`,
        cookies: { rid: owner.cookie },
      })
    ).json() as Array<{ kind: string; department: string; sessionId: string | null }>;
    expect(tasks.some((t) => t.kind === "mention" && t.department === "seo")).toBe(true);
  });

  it("keeps anything leaving the building #13-gated (a social post is pending, never auto-sent)", async () => {
    const owner = await newOwner();
    await seed(owner);
    const action = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      cookies: { rid: owner.cookie },
      payload: {
        actionType: "external.send",
        payload: { kind: "social.post", summary: "Launch day thread", target: "x" },
      },
    });
    expect(action.statusCode).toBe(202);
    expect(action.json().status).toBe("pending");
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
