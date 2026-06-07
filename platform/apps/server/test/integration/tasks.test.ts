import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createMemory } from "../../src/db/repositories/memories.js";

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

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

/** Sign up a fresh human owner in a fresh workspace. */
async function newOwner(): Promise<Owner> {
  const slug = `tasks-${newId()}`;
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

/** Register an agent; return its member id and Bearer token. */
async function newAgent(owner: Owner, name: string): Promise<{ memberId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json();
  return { memberId: reg.memberId, token: reg.token };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function createTask(owner: Owner, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/tasks`,
    cookies: { rid: owner.cookie },
    payload,
  });
}

describe("Tasks: lifecycle, assignment, auto-routing, links (real Postgres)", () => {
  it("create → assign agent → agent drives status to done; events record the chain", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Worker");

    const task = (await createTask(owner, { title: "Ship #14", labels: ["build"] })).json();
    expect(task.status).toBe("backlog");
    expect(task.assigneeMemberId).toBeNull();

    // assign the agent
    const assigned = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/assign`,
      cookies: { rid: owner.cookie },
      payload: { assigneeMemberId: agent.memberId },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().assigneeMemberId).toBe(agent.memberId);

    // the agent (Bearer) walks the lifecycle backlog → todo → in_progress → done
    for (const status of ["todo", "in_progress", "done"]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/tasks/${task.id}/status`,
        headers: bearer(agent.token),
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(status);
    }

    // read reflects it immediately
    const fresh = (await app.inject({ method: "GET", url: `/tasks/${task.id}`, cookies: { rid: owner.cookie } })).json();
    expect(fresh.status).toBe("done");
    expect(fresh.assigneeMemberId).toBe(agent.memberId);

    // events: created, assigned, then three status_changed
    const events = (await app.inject({ method: "GET", url: `/tasks/${task.id}/events`, cookies: { rid: owner.cookie } })).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual([
      "created",
      "assigned",
      "status_changed",
      "status_changed",
      "status_changed",
    ]);

    // an invalid transition is rejected (done → backlog not allowed)
    const bad = await app.inject({
      method: "PATCH",
      url: `/tasks/${task.id}/status`,
      headers: bearer(agent.token),
      payload: { status: "backlog" },
    });
    expect(bad.statusCode).toBe(409);
  });

  it("reassignment preserves the full assignment history", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "AgentA");
    const b = await newAgent(owner, "AgentB");

    const task = (await createTask(owner, { title: "Handoff" })).json();
    await app.inject({ method: "POST", url: `/tasks/${task.id}/assign`, cookies: { rid: owner.cookie }, payload: { assigneeMemberId: a.memberId } });
    await app.inject({ method: "POST", url: `/tasks/${task.id}/assign`, cookies: { rid: owner.cookie }, payload: { assigneeMemberId: b.memberId } });

    const events = (await app.inject({ method: "GET", url: `/tasks/${task.id}/events`, cookies: { rid: owner.cookie } })).json();
    const assignment = events.filter((e: { type: string }) => ["assigned", "reassigned", "unassigned"].includes(e.type));
    expect(assignment).toHaveLength(2);
    expect(assignment[0]).toMatchObject({ type: "assigned", toValue: a.memberId });
    expect(assignment[1]).toMatchObject({ type: "reassigned", fromValue: a.memberId, toValue: b.memberId });
  });

  it("auto-routing assigns the least-loaded eligible agent; no rule → unassigned", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "RouteA");
    const b = await newAgent(owner, "RouteB");

    // both agents are eligible for label 'triage'
    for (const m of [a.memberId, b.memberId]) {
      const r = await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/task-routing-rules`,
        cookies: { rid: owner.cookie },
        payload: { label: "triage", agentMemberId: m },
      });
      expect(r.statusCode).toBe(201);
    }

    // give agent A an open task → A's load is 1, B's is 0
    const preload = (await createTask(owner, { title: "preload", labels: ["triage"] })).json();
    await app.inject({ method: "POST", url: `/tasks/${preload.id}/assign`, cookies: { rid: owner.cookie }, payload: { assigneeMemberId: a.memberId } });

    // auto-route a new triage task → must pick B (least-loaded)
    const routed = (await createTask(owner, { title: "route me", labels: ["triage"], autoRoute: true })).json();
    expect(routed.assigneeMemberId).toBe(b.memberId);

    // a label with no rule → stays unassigned (best-effort, never an error)
    const orphan = (await createTask(owner, { title: "no rule", labels: ["unknown"], autoRoute: true })).json();
    expect(orphan.assigneeMemberId).toBeNull();
  });

  it("task ↔ message/memory links resolve both ways", async () => {
    const owner = await newOwner();

    // a real message in this workspace
    const channel = (await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/channels`, cookies: { rid: owner.cookie }, payload: { name: "general" } })).json();
    const message = (await app.inject({ method: "POST", url: `/channels/${channel.id}/messages`, cookies: { rid: owner.cookie }, payload: { body: "link me" } })).json();
    // a real memory in this workspace (the #15 graph isn't built; use the repo shim directly)
    const memory = await createMemory({ workspaceId: owner.workspaceId, type: "note" });

    const task = (await createTask(owner, { title: "linked work" })).json();
    expect((await app.inject({ method: "POST", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie }, payload: { targetType: "message", targetId: message.id } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie }, payload: { targetType: "memory", targetId: memory.id } })).statusCode).toBe(201);

    // forward
    const links = (await app.inject({ method: "GET", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie } })).json();
    expect(links).toHaveLength(2);

    // reverse: message → task, memory → task
    const byMessage = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/links/message/${message.id}/tasks`, cookies: { rid: owner.cookie } })).json();
    expect(byMessage.map((t: { id: string }) => t.id)).toContain(task.id);
    const byMemory = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/links/memory/${memory.id}/tasks`, cookies: { rid: owner.cookie } })).json();
    expect(byMemory.map((t: { id: string }) => t.id)).toContain(task.id);

    // idempotent re-link, then unlink
    const again = await app.inject({ method: "POST", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie }, payload: { targetType: "message", targetId: message.id } });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);

    expect((await app.inject({ method: "DELETE", url: `/tasks/${task.id}/links/message/${message.id}`, cookies: { rid: owner.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie } })).json()).toHaveLength(1);
  });

  it("rejects cross-workspace task access, assignment, and routing (IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner(); // a member of a *different* workspace

    const taskA = (await createTask(a, { title: "A's task" })).json();

    // B cannot read A's task by id
    expect((await app.inject({ method: "GET", url: `/tasks/${taskA.id}`, cookies: { rid: b.cookie } })).statusCode).toBe(404);

    // B cannot create under A's workspace path
    expect(
      (await app.inject({ method: "POST", url: `/workspaces/${a.workspaceId}/tasks`, cookies: { rid: b.cookie }, payload: { title: "sneaky" } })).statusCode,
    ).toBe(403);

    // A cannot assign A's task to B's member (cross-workspace assignee)
    expect(
      (await app.inject({ method: "POST", url: `/tasks/${taskA.id}/assign`, cookies: { rid: a.cookie }, payload: { assigneeMemberId: b.memberId } })).statusCode,
    ).toBe(404);

    // A cannot create a routing rule targeting B's member
    expect(
      (await app.inject({ method: "POST", url: `/workspaces/${a.workspaceId}/task-routing-rules`, cookies: { rid: a.cookie }, payload: { label: "x", agentMemberId: b.memberId } })).statusCode,
    ).toBe(404);

    // A cannot link A's task to a message from B's workspace
    const chB = (await app.inject({ method: "POST", url: `/workspaces/${b.workspaceId}/channels`, cookies: { rid: b.cookie }, payload: { name: "b-gen" } })).json();
    const msgB = (await app.inject({ method: "POST", url: `/channels/${chB.id}/messages`, cookies: { rid: b.cookie }, payload: { body: "b's msg" } })).json();
    expect(
      (await app.inject({ method: "POST", url: `/tasks/${taskA.id}/links`, cookies: { rid: a.cookie }, payload: { targetType: "message", targetId: msgB.id } })).statusCode,
    ).toBe(404);
  });
});
