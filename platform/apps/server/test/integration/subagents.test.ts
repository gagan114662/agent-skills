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

/**
 * #59 — Custom subagents / agent personas (real Postgres + LocalRuntime).
 *
 * Proves the acceptance criteria end-to-end: a defined `@code-reviewer` runs the real harness scoped
 * to its tools (the persona prompt + tool ceiling are threaded to the harness via env) and threads its
 * result back under the invoking @mention message — AND that a subagent cannot escalate privileges:
 * invoking needs `propagate` (delegation), the persona must itself be permitted in the channel, the
 * requested tool set can only narrow the ceiling, a cross-tenant persona is invisible, and a
 * deactivated persona cannot run.
 *
 * The harness is a cwd-independent `node -e` that echoes the persona env it received, so the test can
 * assert the persona's prompt + (narrowed) tool scope actually reached the agent process.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Echoes the task + the persona env (system prompt + allowed-tools) the harness received, then exits.
const REVIEWER_HARNESS = [
  "-e",
  "console.log('reviewer: task=' + (process.env.AGENT_TASK || 'none'));" +
    "console.log('reviewer: tools=' + (process.env.AGENT_ALLOWED_TOOLS || 'none'));" +
    "console.log('reviewer: prompt=' + (process.env.AGENT_APPEND_SYSTEM_PROMPT || 'none'));",
];

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: REVIEWER_HARNESS }, // node, cwd-independent
    caps: { wallClockMs: 10_000, idleMs: 5_000 },
    logger: silentLogger,
  });
  app = buildApp({ sessionManager: manager });
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `sub-${newId()}`;
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

async function definePersona(
  owner: { cookie: string; workspaceId: string },
  name: string,
  allowedTools: string[] = ["Read", "Grep"],
) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/personas`,
    cookies: { rid: owner.cookie },
    payload: { name, systemPrompt: "Review the diff. Cite file:line.", allowedTools },
  });
}

async function createChannel(owner: { cookie: string; workspaceId: string }, name: string) {
  return (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/channels`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json();
}

async function grant(owner: { cookie: string }, channelId: string, memberId: string, capability: string) {
  return app.inject({
    method: "POST",
    url: `/channels/${channelId}/grants`,
    cookies: { rid: owner.cookie },
    payload: { memberId, capability },
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

async function waitForSession(
  owner: { cookie: string },
  channelId: string,
  sessionId: string,
): Promise<string> {
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

describe("#59 subagents (real Postgres)", () => {
  it("defines @code-reviewer, runs it scoped to its tools, and threads the review under the message", async () => {
    const owner = await newOwner();
    const persona = (await definePersona(owner, `code-reviewer-${newId().slice(0, 8)}`)).json();
    const channel = await createChannel(owner, "dev");
    await grant(owner, channel.id, persona.agentMemberId, "write");

    const msg = await postMessage(owner, channel.id, `@${persona.name} please review this diff`);

    const invoke = await app.inject({
      method: "POST",
      url: `/channels/${channel.id}/messages/${msg.id}/subagents`,
      cookies: { rid: owner.cookie },
      payload: {},
    });
    expect(invoke.statusCode).toBe(202);
    const launched = invoke.json().launched as Array<{ personaId: string; sessionId: string }>;
    expect(launched).toHaveLength(1);
    expect(launched[0].personaId).toBe(persona.id);

    expect(await waitForSession(owner, channel.id, launched[0].sessionId)).toBe("completed");

    // The result threads under the invoking message, posted AS the persona member, and the harness
    // received the persona's prompt + tool ceiling via env (proving it ran scoped to its tools).
    const replies = await threadReplies(owner, channel.id, msg.id);
    const personaReplies = replies.filter((r) => r.authorMemberId === persona.agentMemberId);
    const text = personaReplies.map((r) => r.body).join("\n");
    expect(text).toContain("reviewer: tools=Read,Grep");
    expect(text).toContain("reviewer: prompt=Review the diff. Cite file:line.");
    expect(text).toContain("please review this diff");
  });

  it("narrows a request to the persona ceiling — a subagent cannot widen its tools", async () => {
    const owner = await newOwner();
    const persona = (await definePersona(owner, `rev-${newId().slice(0, 8)}`, ["Read"])).json();
    const channel = await createChannel(owner, "dev");
    await grant(owner, channel.id, persona.agentMemberId, "write");
    const msg = await postMessage(owner, channel.id, `@${persona.name} review`);

    // Request Bash/Write (outside the ["Read"] ceiling) on the explicit invoke route.
    const res = await app.inject({
      method: "POST",
      url: `/channels/${channel.id}/personas/${persona.id}/invoke`,
      cookies: { rid: owner.cookie },
      payload: { task: "review", messageId: msg.id, tools: ["Read", "Bash", "Write"] },
    });
    expect(res.statusCode).toBe(202);
    expect(await waitForSession(owner, channel.id, res.json().sessionId)).toBe("completed");

    // The harness saw ONLY "Read" — Bash/Write were dropped, not granted.
    const replies = await threadReplies(owner, channel.id, msg.id);
    const text = replies.filter((r) => r.authorMemberId === persona.agentMemberId).map((r) => r.body).join("\n");
    expect(text).toContain("reviewer: tools=Read");
    expect(text).not.toContain("Bash");
    expect(text).not.toContain("Write");
  });

  it("rejects invocation by a member without propagate (delegation requires propagate)", async () => {
    const owner = await newOwner();
    const persona = (await definePersona(owner, `rev-${newId().slice(0, 8)}`)).json();
    const channel = await createChannel(owner, "dev");
    await grant(owner, channel.id, persona.agentMemberId, "write");

    const agentReg = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/agents`,
        cookies: { rid: owner.cookie },
        payload: { name: `caller-${newId().slice(0, 8)}` },
      })
    ).json();
    await grant(owner, channel.id, agentReg.memberId, "write"); // write, NOT propagate

    const res = await app.inject({
      method: "POST",
      url: `/channels/${channel.id}/personas/${persona.id}/invoke`,
      headers: bearer(agentReg.token),
      payload: { task: "review" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects invocation when the persona is not permitted in the channel (its own RBAC scope)", async () => {
    const owner = await newOwner();
    const persona = (await definePersona(owner, `rev-${newId().slice(0, 8)}`)).json();
    const channel = await createChannel(owner, "private");
    // Deliberately do NOT grant the persona any capability on the channel.

    const res = await app.inject({
      method: "POST",
      url: `/channels/${channel.id}/personas/${persona.id}/invoke`,
      cookies: { rid: owner.cookie },
      payload: { task: "review" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s a persona from another workspace (tenant isolation)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const personaB = (await definePersona(b, `rev-${newId().slice(0, 8)}`)).json();
    const channelA = await createChannel(a, "dev");

    const res = await app.inject({
      method: "POST",
      url: `/channels/${channelA.id}/personas/${personaB.id}/invoke`,
      cookies: { rid: a.cookie },
      payload: { task: "review" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a deactivated persona can no longer be invoked", async () => {
    const owner = await newOwner();
    const persona = (await definePersona(owner, `rev-${newId().slice(0, 8)}`)).json();
    const channel = await createChannel(owner, "dev");
    await grant(owner, channel.id, persona.agentMemberId, "write");

    const deact = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/personas/${persona.id}/deactivate`,
      cookies: { rid: owner.cookie },
    });
    expect(deact.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${channel.id}/personas/${persona.id}/invoke`,
      cookies: { rid: owner.cookie },
      payload: { task: "review" },
    });
    expect(res.statusCode).toBe(404);
  });
});
