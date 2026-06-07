import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * Issue #16 acceptance matrix against real Postgres — shared memory + task/file linking:
 *   1. shared (agent↔agent): agent A writes a decision; agent B in the same workspace reads & traverses it
 *   2. RBAC: an agent downgraded to `read` can read but not write (403); default agents write
 *   3. linking both ways: memory↔task (reuse #14) and memory↔file (new) resolve in both directions
 *   4. relevant-context: a task's /context returns its linked memory + neighbor, drops a stale node
 *   5. supersede: superseding marks the old node stale (kept, not deleted); it leaves the default list
 *   6. cross-workspace (IDOR): every surface rejects a caller from another workspace
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
  const slug = `shmem-${newId()}`;
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

function postMemory(wid: string, auth: object, body: object) {
  return app.inject({ method: "POST", url: `/workspaces/${wid}/memories`, ...auth, payload: body });
}

describe("Shared memory + task/file linking (real Postgres)", () => {
  it("agent A writes a decision; agent B in the same workspace reads and traverses it", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Writer");
    const b = await newAgent(owner, "Reader");

    // agent A writes a decision and a related fact, then links them
    const decision = await postMemory(owner.workspaceId, { headers: bearer(a.token) }, {
      type: "decision",
      text: "Adopt event sourcing for the ledger",
      entity: "ledger",
    });
    expect(decision.statusCode).toBe(201);
    const dId = decision.json().id as string;
    const fact = await postMemory(owner.workspaceId, { headers: bearer(a.token) }, {
      type: "fact",
      text: "The ledger is append-only",
      entity: "ledger",
    });
    const fId = fact.json().id as string;
    expect(
      (await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/memories/${dId}/edges`,
        headers: bearer(a.token),
        payload: { toMemoryId: fId, relation: "supports" },
      })).statusCode,
    ).toBe(201);

    // agent B — a DIFFERENT agent in the same workspace — reads the shared node and traverses it
    const view = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories/${dId}`,
      headers: bearer(b.token),
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().memory.id).toBe(dId);
    expect(view.json().neighbors.map((n: { id: string }) => n.id)).toContain(fId);

    // B sees the same node via the by-entity query (memory is shared, not siloed per-agent)
    const byEntity = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories?entity=ledger`,
      headers: bearer(b.token),
    });
    expect(byEntity.json().map((n: { id: string }) => n.id)).toEqual(
      expect.arrayContaining([dId, fId]),
    );
  });

  it("RBAC: an agent downgraded to read can read but not write (403); default agents write", async () => {
    const owner = await newOwner();
    const limited = await newAgent(owner, "ReadOnly");

    // by default an agent can write (shared-memory default)
    expect(
      (await postMemory(owner.workspaceId, { headers: bearer(limited.token) }, { type: "fact", text: "default write works" })).statusCode,
    ).toBe(201);

    // owner (human → propagate) downgrades the agent to read-only on memory
    const grant = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/memory/grants`,
      cookies: { rid: owner.cookie },
      payload: { memberId: limited.memberId, capability: "read" },
    });
    expect(grant.statusCode).toBe(201);

    // it can still read…
    expect(
      (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories`, headers: bearer(limited.token) })).statusCode,
    ).toBe(200);
    // …but writes are now rejected
    expect(
      (await postMemory(owner.workspaceId, { headers: bearer(limited.token) }, { type: "fact", text: "should be blocked" })).statusCode,
    ).toBe(403);

    // a read-only agent cannot administer grants either (needs propagate)
    const escalate = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/memory/grants`,
      headers: bearer(limited.token),
      payload: { memberId: limited.memberId, capability: "write" },
    });
    expect(escalate.statusCode).toBe(403);

    // revoking the grant restores the default write capability immediately
    expect(
      (await app.inject({ method: "DELETE", url: `/workspaces/${owner.workspaceId}/memory/grants/${limited.memberId}`, cookies: { rid: owner.cookie } })).statusCode,
    ).toBe(200);
    expect(
      (await postMemory(owner.workspaceId, { headers: bearer(limited.token) }, { type: "fact", text: "writes again" })).statusCode,
    ).toBe(201);
  });

  it("links memory↔task and memory↔file, resolving both ways", async () => {
    const owner = await newOwner();
    const mem = (await postMemory(owner.workspaceId, { cookies: { rid: owner.cookie } }, { type: "decision", text: "Use feature flags for rollout" })).json();
    const task = (await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/tasks`, cookies: { rid: owner.cookie }, payload: { title: "Roll out flags" } })).json();

    // task → memory link (reuse #14)
    expect(
      (await app.inject({ method: "POST", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie }, payload: { targetType: "memory", targetId: mem.id } })).statusCode,
    ).toBe(201);
    // forward: the task lists the memory
    const taskLinks = (await app.inject({ method: "GET", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie } })).json();
    expect(taskLinks.map((l: { targetId: string }) => l.targetId)).toContain(mem.id);
    // reverse (memory side, new in #16): the memory lists the task
    const memTasks = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories/${mem.id}/tasks`, cookies: { rid: owner.cookie } })).json();
    expect(memTasks.map((t: { id: string }) => t.id)).toContain(task.id);

    // memory → file link (new in #16)
    const path = "src/flags/rollout.ts";
    const link = await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/memories/${mem.id}/files`, cookies: { rid: owner.cookie }, payload: { path } });
    expect(link.statusCode).toBe(201);
    // idempotent re-link
    expect((await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/memories/${mem.id}/files`, cookies: { rid: owner.cookie }, payload: { path } })).json().created).toBe(false);
    // forward: files for the memory
    const files = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories/${mem.id}/files`, cookies: { rid: owner.cookie } })).json();
    expect(files.map((f: { path: string }) => f.path)).toEqual([path]);
    // reverse: memories for the file path
    const byFile = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories?file=${encodeURIComponent(path)}`, cookies: { rid: owner.cookie } })).json();
    expect(byFile.map((m: { id: string }) => m.id)).toContain(mem.id);
    // unlink
    expect((await app.inject({ method: "DELETE", url: `/workspaces/${owner.workspaceId}/memories/${mem.id}/files`, cookies: { rid: owner.cookie }, payload: { path } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories/${mem.id}/files`, cookies: { rid: owner.cookie } })).json()).toHaveLength(0);
  });

  it("relevant-context returns the task's linked memory + neighbor, dropping a stale node", async () => {
    const owner = await newOwner();
    // a linked decision and a fact it relates to (the neighbor)
    const decision = (await postMemory(owner.workspaceId, { cookies: { rid: owner.cookie } }, { type: "decision", text: "Cache sessions in Redis", entity: "cache" })).json();
    const neighbor = (await postMemory(owner.workspaceId, { cookies: { rid: owner.cookie } }, { type: "fact", text: "Redis TTL is 24h" })).json();
    await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/memories/${decision.id}/edges`, cookies: { rid: owner.cookie }, payload: { toMemoryId: neighbor.id, relation: "supports" } });
    // an unrelated, soon-to-be-stale node tagged with the task's label entity
    const stale = (await postMemory(owner.workspaceId, { cookies: { rid: owner.cookie } }, { type: "fact", text: "Old cap is 1000 sessions", entity: "cache" })).json();

    const task = (await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/tasks`, cookies: { rid: owner.cookie }, payload: { title: "Tune cache", labels: ["cache"] } })).json();
    await app.inject({ method: "POST", url: `/tasks/${task.id}/links`, cookies: { rid: owner.cookie }, payload: { targetType: "memory", targetId: decision.id } });

    // supersede the stale node so it should drop out of context
    const sup = await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/memories/${stale.id}/supersede`, cookies: { rid: owner.cookie }, payload: { type: "fact", text: "New cap is 100000 sessions", entity: "cache" } });
    expect(sup.statusCode).toBe(201);

    const ctx = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/tasks/${task.id}/context`, cookies: { rid: owner.cookie } })).json();
    const ids = ctx.map((e: { id: string }) => e.id);
    expect(ids).toContain(decision.id); // linked
    expect(ids).toContain(neighbor.id); // neighbor of the linked node
    expect(ids).not.toContain(stale.id); // stale → excluded
    expect(ctx.find((e: { id: string }) => e.id === decision.id).reason).toBe("linked");
  });

  it("supersede marks the old node stale (kept, not deleted) and drops it from the default list", async () => {
    const owner = await newOwner();
    const entity = `ver-${newId()}`;
    const v1 = (await postMemory(owner.workspaceId, { cookies: { rid: owner.cookie } }, { type: "decision", text: "Ship weekly", entity })).json();

    const sup = await app.inject({ method: "POST", url: `/workspaces/${owner.workspaceId}/memories/${v1.id}/supersede`, cookies: { rid: owner.cookie }, payload: { type: "decision", text: "Ship daily", entity } });
    expect(sup.statusCode).toBe(201);
    const v2Id = sup.json().memory.id as string;
    expect(sup.json().supersededId).toBe(v1.id);

    // old node is still fetchable by id, now flagged superseded (kept, not deleted)
    const old = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories/${v1.id}`, cookies: { rid: owner.cookie } })).json();
    expect(old.memory.id).toBe(v1.id);
    expect(old.memory.supersededByMemoryId).toBe(v2Id);

    // default list for the entity shows only the live (new) node…
    const live = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories?entity=${entity}`, cookies: { rid: owner.cookie } })).json();
    expect(live.map((m: { id: string }) => m.id)).toEqual([v2Id]);
    // …and includeStale surfaces both versions
    const all = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories?entity=${entity}&includeStale=true`, cookies: { rid: owner.cookie } })).json();
    expect(all.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([v1.id, v2Id]));

    // the lineage edge new --supersedes--> old exists
    const newView = (await app.inject({ method: "GET", url: `/workspaces/${owner.workspaceId}/memories/${v2Id}`, cookies: { rid: owner.cookie } })).json();
    expect(newView.outgoing).toEqual(
      expect.arrayContaining([expect.objectContaining({ toMemoryId: v1.id, relation: "supersedes" })]),
    );
  });

  it("rejects cross-workspace access on every memory surface (IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner(); // a member of a different workspace
    const mem = (await postMemory(a.workspaceId, { cookies: { rid: a.cookie } }, { type: "fact", text: "secret to A" })).json();

    // B cannot read, write, supersede, link, or administer grants on A's workspace memory
    expect((await app.inject({ method: "GET", url: `/workspaces/${a.workspaceId}/memories`, cookies: { rid: b.cookie } })).statusCode).toBe(403);
    expect((await postMemory(a.workspaceId, { cookies: { rid: b.cookie } }, { type: "fact", text: "intrusion" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/workspaces/${a.workspaceId}/memories/${mem.id}/supersede`, cookies: { rid: b.cookie }, payload: { type: "fact", text: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/workspaces/${a.workspaceId}/memories/${mem.id}/files`, cookies: { rid: b.cookie }, payload: { path: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/workspaces/${a.workspaceId}/memories/${mem.id}/tasks`, cookies: { rid: b.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/workspaces/${a.workspaceId}/memory/grants`, cookies: { rid: b.cookie }, payload: { memberId: b.memberId, capability: "read" } })).statusCode).toBe(403);

    // B cannot fetch A's node through B's own (matching) workspace path → 404, never leaks
    expect((await app.inject({ method: "GET", url: `/workspaces/${b.workspaceId}/memories/${mem.id}`, cookies: { rid: b.cookie } })).statusCode).toBe(404);
  });
});
