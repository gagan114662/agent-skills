import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * Issue #15 acceptance matrix against real Postgres:
 *   1. typed nodes + a typed edge, then traverse (node + neighbors)
 *   2. auto-capture creates a typed memory from the source it captures
 *   3. dedup collapses obvious duplicates to one node
 *   4. cross-workspace access is rejected (the #3 IDOR guard)
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

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `mem-${newId()}`;
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

function createNode(
  owner: { cookie: string; workspaceId: string },
  body: { type: string; text: string; entity?: string },
) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/memories`,
    cookies: { rid: owner.cookie },
    payload: body,
  });
}

describe("memory graph: typed nodes + edges (real Postgres)", () => {
  it("creates typed nodes and a typed edge, then traverses node + neighbors", async () => {
    const owner = await newOwner();

    const decision = await createNode(owner, {
      type: "decision",
      text: "Use Postgres for storage",
      entity: "storage",
    });
    const fact = await createNode(owner, { type: "fact", text: "The API runs on port 3000" });
    expect(decision.statusCode).toBe(201);
    expect(fact.statusCode).toBe(201);
    const dId = decision.json().id as string;
    const fId = fact.json().id as string;
    expect(decision.json().type).toBe("decision");

    // a typed edge decision --relates_to--> fact
    const edge = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/memories/${dId}/edges`,
      cookies: { rid: owner.cookie },
      payload: { toMemoryId: fId, relation: "relates_to" },
    });
    expect(edge.statusCode).toBe(201);

    // traverse: node + neighbors
    const view = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories/${dId}`,
      cookies: { rid: owner.cookie },
    });
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body.memory.id).toBe(dId);
    expect(body.outgoing).toHaveLength(1);
    expect(body.outgoing[0]).toMatchObject({ toMemoryId: fId, relation: "relates_to" });
    expect(body.neighbors.map((n: { id: string }) => n.id)).toContain(fId);

    // query by type and by entity
    const byType = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories?type=decision`,
      cookies: { rid: owner.cookie },
    });
    expect(byType.json().map((n: { id: string }) => n.id)).toContain(dId);

    const byEntity = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories?entity=storage`,
      cookies: { rid: owner.cookie },
    });
    expect(byEntity.json().map((n: { id: string }) => n.id)).toEqual([dId]);
  });

  it("auto-captures typed nodes + edges from the source it captures", async () => {
    const owner = await newOwner();
    const sourceId = newId();

    const capture = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/memories/capture`,
      cookies: { rid: owner.cookie },
      payload: {
        text: "We decided to ship daily\nCI runs on every push",
        sourceType: "message",
        sourceId,
      },
    });
    expect(capture.statusCode).toBe(201);
    const result = capture.json();
    expect(result.memories).toHaveLength(2);
    expect(result.edges).toHaveLength(1); // second statement relates_to the anchor
    expect(result.memories[0].type).toBe("decision");
    expect(result.memories.every((m: { created: boolean }) => m.created)).toBe(true);

    // the captured node carries its source provenance
    const node = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories/${result.memories[0].id}`,
      cookies: { rid: owner.cookie },
    });
    expect(node.json().memory.sourceType).toBe("message");
    expect(node.json().memory.sourceId).toBe(sourceId);
    expect(node.json().memory.content.text).toBe("We decided to ship daily");
  });

  it("dedups obvious duplicates to a single node", async () => {
    const owner = await newOwner();
    const entity = `dedup-${newId()}`;

    const first = await createNode(owner, { type: "fact", text: "The sky is blue", entity });
    const second = await createNode(owner, {
      type: "fact",
      text: "  the   SKY is BLUE  ", // same statement, different case/whitespace
      entity,
    });
    expect(first.statusCode).toBe(201); // created
    expect(second.statusCode).toBe(200); // merged into the existing node
    expect(second.json().id).toBe(first.json().id);

    // exactly one node exists for that entity
    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories?entity=${entity}`,
      cookies: { rid: owner.cookie },
    });
    expect(list.json()).toHaveLength(1);

    // capturing the same source twice is idempotent too
    const cap1 = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/memories/capture`,
      cookies: { rid: owner.cookie },
      payload: { text: "Deploys are gated on green CI" },
    });
    const cap2 = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/memories/capture`,
      cookies: { rid: owner.cookie },
      payload: { text: "Deploys are gated on green CI" },
    });
    expect(cap1.json().memories[0].created).toBe(true);
    expect(cap2.json().memories[0].created).toBe(false);
    expect(cap2.json().memories[0].id).toBe(cap1.json().memories[0].id);
  });

  it("rejects cross-workspace access (IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const node = await createNode(a, { type: "fact", text: "secret to workspace A" });
    const aMemoryId = node.json().id as string;

    // B cannot read or write A's workspace memories
    const readAsB = await app.inject({
      method: "GET",
      url: `/workspaces/${a.workspaceId}/memories`,
      cookies: { rid: b.cookie },
    });
    expect(readAsB.statusCode).toBe(403);

    const writeAsB = await app.inject({
      method: "POST",
      url: `/workspaces/${a.workspaceId}/memories`,
      cookies: { rid: b.cookie },
      payload: { type: "fact", text: "intrusion" },
    });
    expect(writeAsB.statusCode).toBe(403);

    // B cannot fetch A's node by id through B's own workspace path
    const peek = await app.inject({
      method: "GET",
      url: `/workspaces/${b.workspaceId}/memories/${aMemoryId}`,
      cookies: { rid: b.cookie },
    });
    expect(peek.statusCode).toBe(404);

    // an edge whose target node lives in another workspace is rejected
    const bNode = await createNode(b, { type: "fact", text: "belongs to B" });
    const crossEdge = await app.inject({
      method: "POST",
      url: `/workspaces/${b.workspaceId}/memories/${bNode.json().id}/edges`,
      cookies: { rid: b.cookie },
      payload: { toMemoryId: aMemoryId, relation: "relates_to" },
    });
    expect(crossEdge.statusCode).toBe(404);
  });
});
