import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { validateDef, type JsonSchema } from "../../src/protocols/jsonschema.js";

/**
 * #12 — ACP adapter (real Postgres). Proves the acceptance criterion "ACP messages map correctly to
 * channels/threads": an ACP run posts its input into a channel thread, the thread root is the run
 * id, a continuation lands as a reply, and the run's output is the target agent's in-thread replies.
 * Workspace-scoped (#3 IDOR) + capability-gated (#9) throughout, and the emitted Run conforms to the
 * vendored published ACP schema.
 */
const acpSchema = JSON.parse(
  readFileSync(new URL("../fixtures/acp.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `acp-${newId()}`;
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

async function newAgent(
  owner: { cookie: string; workspaceId: string },
  name: string,
): Promise<{ memberId: string; agentId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name, framework: "crewai" },
    })
  ).json();
  return { memberId: reg.memberId, agentId: reg.agentId, token: reg.token };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function createChannel(owner: { cookie: string; workspaceId: string }, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/channels`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  return res.json().id as string;
}

async function grant(
  owner: { cookie: string },
  channelId: string,
  memberId: string,
  capability: "read" | "write" | "propagate",
): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/channels/${channelId}/grants`,
    cookies: { rid: owner.cookie },
    payload: { memberId, capability },
  });
}

const userMsg = (text: string) => ({ role: "user", parts: [{ content_type: "text/plain", content: text }] });

describe("#12 ACP adapter (real Postgres)", () => {
  it("maps an ACP run's messages onto a channel thread, with output = the agent's replies", async () => {
    const owner = await newOwner();
    const handle = `planner${newId().replace(/-/g, "")}`;
    const agent = await newAgent(owner, handle);
    const general = await createChannel(owner, "general");
    await grant(owner, general, agent.memberId, "write"); // agent may reply in-thread

    // discovery: the agent appears as an ACP manifest
    const manifest = await app.inject({ method: "GET", url: "/acp/agents", cookies: { rid: owner.cookie } });
    expect(manifest.statusCode).toBe(200);
    expect((manifest.json() as { name: string }[]).some((a) => a.name === handle)).toBe(true);

    // create a run → posts input into the channel as a thread root @mentioning the agent
    const create = await app.inject({
      method: "POST",
      url: "/acp/runs",
      cookies: { rid: owner.cookie },
      payload: { agent_name: handle, input: [userMsg("plan the launch")], metadata: { channel_id: general } },
    });
    expect(create.statusCode).toBe(201);
    const run = create.json();
    expect(run.agent_name).toBe(handle);
    expect(run.status).toBe("created");
    expect(run.output).toEqual([]);
    expect(validateDef(acpSchema, "Run", run).valid).toBe(true); // live conformance
    const runId = run.run_id as string;

    // the message landed in the channel as a thread root (messages ↔ channel/thread)
    const msgs = await app.inject({
      method: "GET",
      url: `/channels/${general}/messages`,
      cookies: { rid: owner.cookie },
    });
    const root = (msgs.json() as { id: string; body: string; parentMessageId: string | null }[]).find(
      (m) => m.id === runId,
    );
    expect(root).toBeDefined();
    expect(root!.body).toBe(`@${handle} plan the launch`);
    expect(root!.parentMessageId).toBeNull();

    // the agent replies in-thread → the run's output picks it up, status flips to completed
    const reply = await app.inject({
      method: "POST",
      url: `/channels/${general}/messages/${runId}/replies`,
      headers: bearer(agent.token),
      payload: { body: "here is the plan" },
    });
    expect(reply.statusCode).toBe(201);

    const read = await app.inject({
      method: "GET",
      url: `/acp/runs/${runId}`,
      cookies: { rid: owner.cookie },
    });
    expect(read.statusCode).toBe(200);
    const completed = read.json();
    expect(completed.status).toBe("completed");
    expect(completed.output).toHaveLength(1);
    expect(completed.output[0].role).toBe("agent");
    expect(completed.output[0].parts[0].content).toBe("here is the plan");
    expect(validateDef(acpSchema, "Run", completed).valid).toBe(true);

    // continue the run via session_id → the new input lands as another reply in the SAME thread
    const cont = await app.inject({
      method: "POST",
      url: "/acp/runs",
      cookies: { rid: owner.cookie },
      payload: { agent_name: handle, session_id: runId, input: [userMsg("and the budget?")] },
    });
    expect(cont.statusCode).toBe(201);
    expect(cont.json().run_id).toBe(runId); // same thread root = same run

    const thread = await app.inject({
      method: "GET",
      url: `/channels/${general}/messages/${runId}/thread`,
      cookies: { rid: owner.cookie },
    });
    const bodies = (thread.json().replies as { body: string }[]).map((r) => r.body);
    expect(bodies).toContain("here is the plan");
    expect(bodies).toContain("and the budget?");
  });

  it("rejects a new run with no channel, and a run id from another workspace (#3 IDOR)", async () => {
    const a = await newOwner();
    const handleA = `pa${newId().replace(/-/g, "")}`;
    const agentA = await newAgent(a, handleA);
    const generalA = await createChannel(a, "secrets");
    await grant(a, generalA, agentA.memberId, "write");
    const created = await app.inject({
      method: "POST",
      url: "/acp/runs",
      cookies: { rid: a.cookie },
      payload: { agent_name: handleA, input: [userMsg("classified")], metadata: { channel_id: generalA } },
    });
    const runIdA = created.json().run_id as string;

    // a new run with no channel and no session → 400
    const b = await newOwner();
    const handleB = `pb${newId().replace(/-/g, "")}`;
    await newAgent(b, handleB);
    const noChannel = await app.inject({
      method: "POST",
      url: "/acp/runs",
      cookies: { rid: b.cookie },
      payload: { agent_name: handleB, input: [userMsg("hi")] },
    });
    expect(noChannel.statusCode).toBe(400);

    // B cannot read A's run (404, existence never leaks)
    const crossRead = await app.inject({
      method: "GET",
      url: `/acp/runs/${runIdA}`,
      cookies: { rid: b.cookie },
    });
    expect(crossRead.statusCode).toBe(404);

    // B cannot create a run that posts into A's channel (404 on the channel)
    const crossPost = await app.inject({
      method: "POST",
      url: "/acp/runs",
      cookies: { rid: b.cookie },
      payload: { agent_name: handleB, input: [userMsg("leak")], metadata: { channel_id: generalA } },
    });
    expect(crossPost.statusCode).toBe(404);
  });

  it("rejects unauthenticated discovery", async () => {
    const res = await app.inject({ method: "GET", url: "/acp/agents" });
    expect(res.statusCode).toBe(401);
  });
});
