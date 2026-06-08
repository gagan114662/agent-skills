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
 * #12 — A2A adapter (real Postgres). Proves the acceptance criterion "A2A handoff transfers a task
 * with context intact": agent A `message/send`s to agent B, which creates a task assigned to B with
 * the message content preserved; B's `tasks/get` returns the task AND the original content. Also
 * proves the AgentCard capability handshake, the cancel path, conformance, and cross-workspace +
 * unauth rejection.
 */
const a2aSchema = JSON.parse(
  readFileSync(new URL("../fixtures/a2a.schema.json", import.meta.url), "utf8"),
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
  const slug = `a2a-${newId()}`;
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
  framework?: string,
): Promise<{ memberId: string; agentId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name, framework },
    })
  ).json();
  return { memberId: reg.memberId, agentId: reg.agentId, token: reg.token };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const rpc = (method: string, params: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("#12 A2A adapter (real Postgres)", () => {
  it("serves the AgentCard handshake (bearer auth + handoff skill)", async () => {
    const owner = await newOwner();
    const sender = await newAgent(owner, `s${newId().replace(/-/g, "")}`);
    const receiver = await newAgent(owner, `r${newId().replace(/-/g, "")}`, "langgraph");

    const res = await app.inject({
      method: "GET",
      url: `/a2a/agents/${receiver.agentId}/agent-card.json`,
      headers: bearer(sender.token),
    });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.url).toContain(`/a2a/agents/${receiver.agentId}`);
    expect(card.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    expect((card.skills as { id: string }[]).some((s) => s.id === "handoff")).toBe(true);
    expect(validateDef(a2aSchema, "AgentCard", card).valid).toBe(true);

    // discovery requires a workspace token
    const noAuth = await app.inject({
      method: "GET",
      url: `/a2a/agents/${receiver.agentId}/agent-card.json`,
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it("transfers a task with context intact via message/send → tasks/get", async () => {
    const owner = await newOwner();
    const sender = await newAgent(owner, `s${newId().replace(/-/g, "")}`);
    const receiver = await newAgent(owner, `r${newId().replace(/-/g, "")}`);

    // A hands off to B with a text message
    const send = await app.inject({
      method: "POST",
      url: `/a2a/agents/${receiver.agentId}`,
      headers: bearer(sender.token),
      payload: rpc("message/send", {
        message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "investigate the outage" }] },
      }),
    });
    expect(send.statusCode).toBe(200);
    const sendBody = send.json();
    expect(sendBody.jsonrpc).toBe("2.0");
    const task = sendBody.result;
    expect(task.kind).toBe("task");
    expect(task.status.state).toBe("submitted");
    expect(validateDef(a2aSchema, "Task", task).valid).toBe(true);
    const taskId = task.id as string;

    // B retrieves the handed-off task and sees the ORIGINAL content intact
    const get = await app.inject({
      method: "POST",
      url: `/a2a/agents/${receiver.agentId}`,
      headers: bearer(receiver.token),
      payload: rpc("tasks/get", { id: taskId }, 2),
    });
    expect(get.statusCode).toBe(200);
    const got = get.json().result;
    expect(got.id).toBe(taskId);
    expect(got.history[0].parts[0].text).toBe("investigate the outage"); // context intact
    expect(validateDef(a2aSchema, "Task", got).valid).toBe(true);

    // the task is genuinely assigned to B (cross-checked via the native task route)
    const native = await app.inject({ method: "GET", url: `/tasks/${taskId}`, cookies: { rid: owner.cookie } });
    expect(native.json().assigneeMemberId).toBe(receiver.memberId);
    expect(native.json().labels).toContain("a2a");

    // B cancels it
    const cancel = await app.inject({
      method: "POST",
      url: `/a2a/agents/${receiver.agentId}`,
      headers: bearer(receiver.token),
      payload: rpc("tasks/cancel", { id: taskId }, 3),
    });
    expect(cancel.json().result.status.state).toBe("canceled");
  });

  it("returns JSON-RPC errors for unknown methods and rejects cross-workspace + unauth", async () => {
    const a = await newOwner();
    const senderA = await newAgent(a, `s${newId().replace(/-/g, "")}`);
    const receiverA = await newAgent(a, `r${newId().replace(/-/g, "")}`);
    const send = await app.inject({
      method: "POST",
      url: `/a2a/agents/${receiverA.agentId}`,
      headers: bearer(senderA.token),
      payload: rpc("message/send", {
        message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "secret task" }] },
      }),
    });
    const taskIdA = send.json().result.id as string;

    // unknown method → JSON-RPC method-not-found
    const unknown = await app.inject({
      method: "POST",
      url: `/a2a/agents/${receiverA.agentId}`,
      headers: bearer(senderA.token),
      payload: rpc("tasks/teleport", {}),
    });
    expect(unknown.json().error.code).toBe(-32601);

    // a token from another workspace cannot read A's task (TaskNotFound), nor A's AgentCard (404)
    const b = await newOwner();
    const agentB = await newAgent(b, `i${newId().replace(/-/g, "")}`);
    const crossGet = await app.inject({
      method: "POST",
      url: `/a2a/agents/${agentB.agentId}`,
      headers: bearer(agentB.token),
      payload: rpc("tasks/get", { id: taskIdA }, 9),
    });
    expect(crossGet.json().error.code).toBe(-32001);

    const crossCard = await app.inject({
      method: "GET",
      url: `/a2a/agents/${receiverA.agentId}/agent-card.json`,
      headers: bearer(agentB.token),
    });
    expect(crossCard.statusCode).toBe(404);

    // unauthenticated JSON-RPC → 401
    const noAuth = await app.inject({
      method: "POST",
      url: `/a2a/agents/${receiverA.agentId}`,
      payload: rpc("tasks/get", { id: taskIdA }),
    });
    expect(noAuth.statusCode).toBe(401);
  });
});
