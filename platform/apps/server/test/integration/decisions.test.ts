import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * Issue #513 acceptance against real Postgres — the shared decision store:
 *   1. an agent references a decision ANOTHER agent made, without being re-told (record A → recall B)
 *   2. the decision is browsable in the memory graph (the mirror)
 *   3. re-recording the same decision is idempotent (dedup)
 *   4. a newer decision supersedes the old (kept, excluded from the live recall)
 *   5. an external/money decision is recorded but its action is parked behind the #13 approval gate
 *   6. the department "decisions captured" counter is backed by the real store
 *   7. user-facing output carries no internal agent chatter (sanitization)
 *   8. cross-workspace access is rejected (the #3 IDOR guard)
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
  const slug = `dec-${newId()}`;
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

function record(wid: string, auth: object, body: object) {
  return app.inject({ method: "POST", url: `/workspaces/${wid}/decisions`, ...auth, payload: body });
}

describe("shared decision store (real Postgres)", () => {
  it("agent B references a decision agent A made — without being re-told", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Strategist");
    const b = await newAgent(owner, "Writer");

    // agent A records a decision last "week"
    const rec = await record(owner.workspaceId, { headers: bearer(a.token) }, {
      topic: "Pricing page",
      title: "Lead with the annual plan",
      rationale: "It lifts average commitment and reads simpler",
    });
    expect(rec.statusCode).toBe(201);
    expect(rec.json().pendingApproval).toBe(false);

    // agent B, a different agent, recalls the topic and gets A's decision back
    const recall = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/decisions/recall?topic=${encodeURIComponent("Pricing page")}`,
      headers: bearer(b.token),
    });
    expect(recall.statusCode).toBe(200);
    const payload = recall.json();
    expect(payload.decisions).toHaveLength(1);
    expect(payload.decisions[0].title).toBe("Lead with the annual plan");
    expect(payload.brief).toContain("Lead with the annual plan");
  });

  it("the recorded decision is browsable in the memory graph (the mirror)", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Strategist");
    await record(owner.workspaceId, { headers: bearer(a.token) }, {
      topic: "Brand voice",
      title: "Adopt a warm, plain tone",
      rationale: "Matches how customers describe us",
    });

    // browse the decision store
    const browse = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/decisions`,
      headers: bearer(a.token),
    });
    expect(browse.statusCode).toBe(200);
    expect(browse.json().some((d: { title: string }) => d.title === "Adopt a warm, plain tone")).toBe(true);

    // and it shows up as a `decision` node in the existing memory graph view
    const graph = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/memories?type=decision`,
      headers: bearer(a.token),
    });
    expect(graph.statusCode).toBe(200);
    expect(
      graph.json().some((n: { content: { text: string }; entity: string }) =>
        n.content.text === "Adopt a warm, plain tone" && n.entity === "brand voice"),
    ).toBe(true);
  });

  it("re-recording the same decision is idempotent (dedup → 200, created:false)", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Strategist");
    const body = { topic: "Launch", title: "Ship on Tuesday", rationale: "Avoids the Friday risk" };
    const first = await record(owner.workspaceId, { headers: bearer(a.token) }, body);
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    // same statement, different casing/whitespace — collapses to the same row
    const again = await record(owner.workspaceId, { headers: bearer(a.token) }, {
      topic: "  launch ",
      title: "ship on TUESDAY",
      rationale: "Avoids the Friday risk",
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(again.json().id).toBe(first.json().id);
  });

  it("supersede: the newer decision replaces the old (kept, excluded from the live recall)", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Strategist");
    const v1 = await record(owner.workspaceId, { headers: bearer(a.token) }, {
      topic: "Channel",
      title: "Focus on LinkedIn",
      rationale: "Where the buyers are",
    });
    const oldId = v1.json().id as string;
    const sup = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/decisions/${oldId}/supersede`,
      headers: bearer(a.token),
      payload: { topic: "Channel", title: "Focus on YouTube", rationale: "Higher-intent demand now" },
    });
    expect(sup.statusCode).toBe(201);
    expect(sup.json().supersededId).toBe(oldId);

    // default browse excludes the stale one; recall returns only the live decision
    const live = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/decisions?topic=Channel`,
      headers: bearer(a.token),
    });
    const titles = live.json().map((d: { title: string }) => d.title);
    expect(titles).toContain("Focus on YouTube");
    expect(titles).not.toContain("Focus on LinkedIn");

    // includeSuperseded surfaces the version history
    const all = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/decisions?topic=Channel&includeSuperseded=true`,
      headers: bearer(a.token),
    });
    expect(all.json().map((d: { title: string }) => d.title)).toContain("Focus on LinkedIn");
  });

  it("an external/money decision is recorded but its action is parked behind the #13 gate", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Strategist");
    const rec = await record(owner.workspaceId, { headers: bearer(a.token) }, {
      topic: "Domain",
      title: "Buy getfoolish.com",
      rationale: "The exact-match domain is worth it",
      external: { actionType: "external.send", amount: 1200, summary: "Purchase domain getfoolish.com" },
    });
    expect(rec.statusCode).toBe(201);
    expect(rec.json().pendingApproval).toBe(true);
    const approvalRequestId = rec.json().approvalRequestId as string;
    expect(approvalRequestId).toBeTruthy();

    // the action is a PENDING request in the #13 gate — nothing executed
    const pending = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/approvals?status=pending`,
      cookies: { rid: owner.cookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().items.some((r: { id: string }) => r.id === approvalRequestId)).toBe(true);
  });

  it("the department 'decisions captured' counter is backed by the real store", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Strategist");
    const before = (await app.inject({ method: "GET", url: "/me/department", cookies: { rid: owner.cookie } })).json();
    const start = before.rail.decisionsCaptured as number;

    await record(owner.workspaceId, { headers: bearer(a.token) }, {
      topic: "Roadmap",
      title: "Cut the v2 dashboard",
      rationale: "It is not on the critical path",
    });

    const after = (await app.inject({ method: "GET", url: "/me/department", cookies: { rid: owner.cookie } })).json();
    expect(after.rail.decisionsCaptured).toBe(start + 1);
    expect(after.rail.summary).toContain(`${start + 1} decisions captured`);
  });

  it("user-facing output carries no internal agent chatter (sanitization end-to-end)", async () => {
    const owner = await newOwner();
    const a = await newAgent(owner, "Strategist");
    const rec = await record(owner.workspaceId, { headers: bearer(a.token) }, {
      topic: "Handoff",
      title: "@scout Okay, so I think we ship the post",
      rationale: "Solid draft; handing off via A2A #content for a human to grab",
    });
    const body = rec.json();
    expect(body.title).toBe("we ship the post");
    expect(`${body.title} ${body.rationale}`).not.toMatch(/@scout|A2A|#content|hand[- ]?off|for a human to grab/i);
  });

  it("rejects a cross-workspace read (the #3 IDOR guard)", async () => {
    const ownerA = await newOwner();
    const a = await newAgent(ownerA, "A");
    await record(ownerA.workspaceId, { headers: bearer(a.token) }, {
      topic: "Secret",
      title: "Internal only",
      rationale: "Stays in workspace A",
    });
    const ownerB = await newOwner();
    const b = await newAgent(ownerB, "B");
    // agent B (workspace B) tries to read workspace A's decisions
    const cross = await app.inject({
      method: "GET",
      url: `/workspaces/${ownerA.workspaceId}/decisions`,
      headers: bearer(b.token),
    });
    expect(cross.statusCode).toBe(403);
  });
});
