import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createMemory } from "../../src/db/repositories/memories.js";

/**
 * #515 — task dependencies/blockers + explicit handoffs, over real Postgres. Extends the #14 task
 * system: a task can be blocked by another (cycles rejected, cross-workspace rejected, a blocked task
 * can't start), and reassignment-as-handoff carries a note + artifact links as one audited event.
 */

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

async function newOwner(): Promise<Owner> {
  const slug = `dep-${newId()}`;
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

function setStatus(owner: Owner, taskId: string, status: string) {
  return app.inject({
    method: "PATCH",
    url: `/tasks/${taskId}/status`,
    cookies: { rid: owner.cookie },
    payload: { status },
  });
}

describe("#515 dependencies/blockers (real Postgres)", () => {
  it("a blocked task can't start until its blocker is terminal", async () => {
    const owner = await newOwner();
    const blocker = (await createTask(owner, { title: "design API" })).json();
    const blocked = (await createTask(owner, { title: "build API" })).json();

    // declare: 'build API' is blocked by 'design API'
    const dep = await app.inject({
      method: "POST",
      url: `/tasks/${blocked.id}/dependencies`,
      cookies: { rid: owner.cookie },
      payload: { blockerTaskId: blocker.id },
    });
    expect(dep.statusCode).toBe(201);
    expect(dep.json().created).toBe(true);

    // moving the blocked task to in_progress is refused while the blocker is open
    await setStatus(owner, blocked.id, "todo");
    const tooEarly = await setStatus(owner, blocked.id, "in_progress");
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toContain("blocked by 1 unfinished task");

    // finish the blocker → the blocked task can now start
    await setStatus(owner, blocker.id, "todo");
    await setStatus(owner, blocker.id, "in_progress");
    await setStatus(owner, blocker.id, "done");
    const now = await setStatus(owner, blocked.id, "in_progress");
    expect(now.statusCode).toBe(200);
    expect(now.json().status).toBe("in_progress");
  });

  it("a canceled blocker is satisfied (no longer holds work back)", async () => {
    const owner = await newOwner();
    const blocker = (await createTask(owner, { title: "spike" })).json();
    const blocked = (await createTask(owner, { title: "depends on spike" })).json();
    await app.inject({
      method: "POST",
      url: `/tasks/${blocked.id}/dependencies`,
      cookies: { rid: owner.cookie },
      payload: { blockerTaskId: blocker.id },
    });
    await setStatus(owner, blocker.id, "canceled");
    await setStatus(owner, blocked.id, "todo");
    expect((await setStatus(owner, blocked.id, "in_progress")).statusCode).toBe(200);
  });

  it("rejects self- and cyclic dependencies; idempotent add", async () => {
    const owner = await newOwner();
    const a = (await createTask(owner, { title: "A" })).json();
    const b = (await createTask(owner, { title: "B" })).json();

    const addDep = (blocked: string, blocker: string) =>
      app.inject({
        method: "POST",
        url: `/tasks/${blocked}/dependencies`,
        cookies: { rid: owner.cookie },
        payload: { blockerTaskId: blocker },
      });

    // self-dependency rejected (would be a cycle)
    expect((await addDep(a.id, a.id)).statusCode).toBe(409);

    // A depends on B (ok), then B depends on A would close a cycle → rejected
    expect((await addDep(a.id, b.id)).statusCode).toBe(201);
    const cycle = await addDep(b.id, a.id);
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().error).toContain("cycle");

    // re-adding the existing edge is idempotent (200, created=false)
    const again = await addDep(a.id, b.id);
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
  });

  it("lists blockers + dependents both ways and removes an edge", async () => {
    const owner = await newOwner();
    const root = (await createTask(owner, { title: "root" })).json();
    const leaf = (await createTask(owner, { title: "leaf" })).json();
    await app.inject({
      method: "POST",
      url: `/tasks/${leaf.id}/dependencies`,
      cookies: { rid: owner.cookie },
      payload: { blockerTaskId: root.id },
    });

    // leaf is blocked by root
    const leafDeps = (await app.inject({ method: "GET", url: `/tasks/${leaf.id}/dependencies`, cookies: { rid: owner.cookie } })).json();
    expect(leafDeps.blockers.map((t: { id: string }) => t.id)).toEqual([root.id]);
    expect(leafDeps.dependents).toEqual([]);

    // root, conversely, blocks leaf
    const rootDeps = (await app.inject({ method: "GET", url: `/tasks/${root.id}/dependencies`, cookies: { rid: owner.cookie } })).json();
    expect(rootDeps.dependents.map((t: { id: string }) => t.id)).toEqual([leaf.id]);

    // remove the edge → gone; removing again is a 404
    expect((await app.inject({ method: "DELETE", url: `/tasks/${leaf.id}/dependencies/${root.id}`, cookies: { rid: owner.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/tasks/${leaf.id}/dependencies/${root.id}`, cookies: { rid: owner.cookie } })).statusCode).toBe(404);
    const after = (await app.inject({ method: "GET", url: `/tasks/${leaf.id}/dependencies`, cookies: { rid: owner.cookie } })).json();
    expect(after.blockers).toEqual([]);
  });

  it("rejects cross-workspace blockers (IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const taskA = (await createTask(a, { title: "A's task" })).json();
    const taskB = (await createTask(b, { title: "B's task" })).json();

    // A cannot make A's task depend on B's task
    const res = await app.inject({
      method: "POST",
      url: `/tasks/${taskA.id}/dependencies`,
      cookies: { rid: a.cookie },
      payload: { blockerTaskId: taskB.id },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("#515 explicit handoff (real Postgres)", () => {
  it("an agent creates a task and hands it to another agent, with a note + artifact link", async () => {
    const owner = await newOwner();
    const scout = await newAgent(owner, "scout");
    const quill = await newAgent(owner, "quill");

    // scout (Bearer) opens a task assigned to itself
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/tasks`,
      headers: bearer(scout.token),
      payload: { title: "Draft launch blog", assigneeMemberId: scout.memberId },
    });
    const task = created.json();
    expect(task.assigneeMemberId).toBe(scout.memberId);

    // a real memory artifact to hand along
    const memory = await createMemory({ workspaceId: owner.workspaceId, type: "brief" });

    // scout hands off to quill with a note + the memory link
    const handoff = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/handoff`,
      headers: bearer(scout.token),
      payload: { toMemberId: quill.memberId, note: "SEO brief is in the linked memory", links: [{ targetType: "memory", targetId: memory.id }] },
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json().assigneeMemberId).toBe(quill.memberId);

    // the handoff is one audited event carrying from→to + the note
    const events = (await app.inject({ method: "GET", url: `/tasks/${task.id}/events`, cookies: { rid: owner.cookie } })).json();
    const ho = events.find((e: { type: string }) => e.type === "handoff");
    expect(ho).toMatchObject({ fromValue: scout.memberId, toValue: quill.memberId });

    // the artifact link came across with the handoff
    const links = (await app.inject({ method: "GET", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie } })).json();
    expect(links.map((l: { targetId: string }) => l.targetId)).toContain(memory.id);

    // quill now sees it on their board column (assigned, status carried over)
    const mine = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/tasks?assignee=${quill.memberId}`, headers: bearer(quill.token) })).json();
    expect(mine.map((t: { id: string }) => t.id)).toContain(task.id);
  });

  it("handing off to a member outside the workspace is rejected", async () => {
    const owner = await newOwner();
    const other = await newOwner();
    const task = (await createTask(owner, { title: "internal" })).json();
    const res = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/handoff`,
      cookies: { rid: owner.cookie },
      payload: { toMemberId: other.memberId },
    });
    expect(res.statusCode).toBe(404);
  });
});
