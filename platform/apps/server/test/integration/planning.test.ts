import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, backlogItems, approvalRequests } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { PlanningService } from "../../src/planning/service.js";
import {
  insertBacklogItem,
  getBacklogItem,
  listBacklogItems,
  updateBacklogItem,
  insertPlanningSpec,
  getSpecForItem,
  listPlanningSpecs,
  linkSpecSession,
  linkSpecApproval,
} from "../../src/db/repositories/planning.js";
import { createRequest } from "../../src/db/repositories/approvals.js";

/** Records what the fake launcher was asked to dispatch (no real session, no model spend). */
const launches: Array<{ workspaceId: string; itemId: string; channelId: string | null; task: string }> = [];
/** Flipped per-scenario to exercise the #95 policy gate. */
let autoAllowed = true;

/**
 * The injected PlanningService: REAL repos (so persistence + tenant isolation are proven against
 * Postgres) but a FAKE launcher (the acceptance criteria) and a real #13 approval queue (so the gate is
 * proven sensitive-by-default). Caps are forced ON so the route-driven tick acts (the default is OFF).
 */
function makePlanning(enabled = true): PlanningService {
  return new PlanningService({
    backlog: {
      insert: insertBacklogItem,
      get: getBacklogItem,
      list: listBacklogItems,
      update: updateBacklogItem,
    },
    specs: {
      insert: insertPlanningSpec,
      getForItem: getSpecForItem,
      list: listPlanningSpecs,
      linkSession: linkSpecSession,
      linkApproval: linkSpecApproval,
    },
    dispatcher: {
      dispatch: async ({ workspaceId, item, spec }) => {
        const id = newId(); // a real session id is a uuid (the soft FK target)
        launches.push({ workspaceId, itemId: item.id, channelId: item.targetChannelId, task: spec.body });
        return { id };
      },
    },
    approvals: {
      enqueue: async ({ workspaceId, item, spec, reason }) => {
        const req = await createRequest({
          workspaceId,
          requesterMemberId: item.targetAgentMemberId!,
          actionType: "planning.dispatch",
          payload: { backlogItemId: item.id, specId: spec.id, reason },
          amount: null,
          summary: `Planning dispatch (${reason}): ${item.title}`,
          status: "pending", // sensitive-by-default — a human approves the launch
          expiresAt: null,
          events: [{ type: "requested", detail: { backlogItemId: item.id, reason } }],
        });
        return { id: req.id };
      },
    },
    caps: () => ({ enabled, autoEffortCeiling: 3, dispatchCostCents: 0, maxDispatchesPerTick: 1 }),
    autoDispatchAllowed: async () => autoAllowed,
    budgetExhausted: async () => false,
    killSwitch: async () => false,
  });
}

const app: FastifyInstance = buildApp({ planning: makePlanning() });
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  cookie: string;
  channelId: string;
  agentMemberId: string;
}

/** Sign up a human, make a channel, register an agent (the build-launch target). */
async function seed(): Promise<World> {
  const slug = `pl-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "build" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Builder" },
  });
  return {
    workspaceId: me.workspaceId,
    cookie,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

async function addItem(w: World, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${w.workspaceId}/planning/items`,
    cookies: { rid: w.cookie },
    payload: {
      targetChannelId: w.channelId,
      targetAgentMemberId: w.agentMemberId,
      ...body,
    },
  });
  return res;
}

const tick = (w: World) =>
  app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/planning/tick`, cookies: { rid: w.cookie } });

describe("product planning loop (real Postgres): evidence → ranked backlog → spec → proposed session", () => {
  it("rejects cross-workspace dispatch targets before persisting a backlog item", async () => {
    const w = await seed();
    const other = await seed();

    const crossChannel = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/planning/items`,
      cookies: { rid: w.cookie },
      payload: {
        title: "Cross-tenant channel",
        source: "manual",
        targetChannelId: other.channelId,
        targetAgentMemberId: w.agentMemberId,
      },
    });
    expect(crossChannel.statusCode).toBe(404);

    const crossAgent = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/planning/items`,
      cookies: { rid: w.cookie },
      payload: {
        title: "Cross-tenant agent",
        source: "manual",
        targetChannelId: w.channelId,
        targetAgentMemberId: other.agentMemberId,
      },
    });
    expect(crossAgent.statusCode).toBe(404);

    const rows = await db
      .select({ id: backlogItems.id })
      .from(backlogItems)
      .where(eq(backlogItems.workspaceId, w.workspaceId));
    expect(rows).toHaveLength(0);
  });

  it(
    "derives RICE from evidence, ranks the backlog, auto-dispatches the top small item through the " +
      "(fake) launcher, #13-gates a pivot and a non-#95-allowed item, surfaces the roadmap, isolates tenants",
    async () => {
      const w = await seed();
      const other = await seed(); // a sibling workspace — must see none of w's backlog (isolation)

      // (1) record three backlog items from evidence (RICE inputs derived from the counts).
      const i1 = await addItem(w, {
        title: "Ship CSV export",
        description: "Top customer ask",
        source: "growth",
        sourceRef: "growth-exp:7",
        evidence: { signalCount: 200, severityTier: 2, corroboratingSources: 3, effortPoints: 2 },
      });
      expect(i1.statusCode).toBe(201);
      // deriveRice: reach 200, impact tier 2, confidence 100% (3 sources), effort 2.
      expect(i1.json()).toMatchObject({ reach: 200, impact: 2, confidencePct: 100, effort: 2, status: "proposed" });

      const i2 = await addItem(w, {
        title: "Re-platform onto multi-tenant core",
        source: "customer_voice",
        sourceRef: "insight:12",
        isPivot: true,
        evidence: { signalCount: 100, severityTier: 3, corroboratingSources: 2, effortPoints: 2 },
      });
      expect(i2.statusCode).toBe(201);
      const i3 = await addItem(w, {
        title: "Fix flaky export test",
        source: "verifier",
        sourceRef: "verifier:99",
        evidence: { signalCount: 60, severityTier: 1, corroboratingSources: 1, effortPoints: 2 },
      });
      const item1Id = i1.json().id;
      const item2Id = i2.json().id;
      const item3Id = i3.json().id;

      // a bad source → 400 (the taxonomy is validated).
      const bad = await addItem(w, { title: "x", source: "vibes", evidence: {} });
      expect(bad.statusCode).toBe(400);

      // (2) the ranked backlog: highest RICE first, with positions + breakdown.
      const backlog = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${w.workspaceId}/planning/backlog`,
          cookies: { rid: w.cookie },
        })
      ).json();
      expect(backlog.map((r) => r.item.id)).toEqual([item1Id, item2Id, item3Id]);
      expect(backlog.map((r) => r.position)).toEqual([1, 2, 3]);
      expect(backlog[0].score).toBeCloseTo(100, 5); // 200 × 1 × 1.0 / 2
      expect(backlog[1].score).toBeCloseTo(80, 5); //  100 × 2 × 0.8 / 2
      expect(backlog[2].score).toBeCloseTo(7.5, 5); //  60 × 0.5 × 0.5 / 2

      // (3) tick #1: the top item (small, non-pivot, #95-allowed, in-budget) auto-dispatches through the
      // fake launcher; the spec is drafted + linked, the item moves to `dispatched`.
      autoAllowed = true;
      const t1 = (await tick(w)).json();
      expect(t1.actions).toHaveLength(1);
      expect(t1.actions[0]).toMatchObject({ itemId: item1Id, action: "auto", reason: "auto_dispatch" });
      expect(t1.actions[0].sessionId).toBeTruthy();
      // the launcher was handed the drafted spec body (so the proposed session carries the spec).
      const launch = launches.find((l) => l.itemId === item1Id)!;
      expect(launch).toBeTruthy();
      expect(launch.channelId).toBe(w.channelId);
      expect(launch.task).toContain("Why ranked here");
      expect(launch.task).toContain("growth-exp:7"); // the why-ranked-here evidence link
      const item1After = await getBacklogItem(w.workspaceId, item1Id);
      expect(item1After?.status).toBe("dispatched");
      const spec1 = await getSpecForItem(w.workspaceId, item1Id);
      expect(spec1?.status).toBe("dispatched");
      expect(spec1?.sessionId).toBe(t1.actions[0].sessionId);
      expect(spec1?.body).toContain("growth-exp:7");

      // (4) tick #2: the next item is a PIVOT → #13-gated (sensitive-by-default), NOT launched.
      const launchesBefore = launches.length;
      const t2 = (await tick(w)).json();
      expect(t2.actions[0]).toMatchObject({ itemId: item2Id, action: "gate", reason: "pivot_requires_approval" });
      expect(launches.length).toBe(launchesBefore); // a pivot never auto-launches
      const approvalId2 = t2.actions[0].approvalRequestId;
      const [approval2] = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.workspaceId, w.workspaceId), eq(approvalRequests.id, approvalId2)));
      expect(approval2.actionType).toBe("planning.dispatch");
      expect(approval2.status).toBe("pending"); // a human must approve the launch — never auto-executed
      const item2After = await getBacklogItem(w.workspaceId, item2Id);
      expect(item2After?.approvalRequestId).toBe(approvalId2);

      // (5) tick #3 with the #95 policy NOT allowing the class: a small, non-pivot item still gates.
      autoAllowed = false;
      const t3 = (await tick(w)).json();
      expect(t3.actions[0]).toMatchObject({ itemId: item3Id, action: "gate", reason: "policy_requires_approval" });
      expect(launches.length).toBe(launchesBefore); // still no new launch (sensitive-by-default)

      // (6) the Founder Console roadmap pane reflects the ranked backlog + lifecycle + evidence links.
      const fc = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${w.workspaceId}/founder-console`,
          cookies: { rid: w.cookie },
        })
      ).json();
      expect(fc.planning.total).toBe(3);
      expect(fc.planning.dispatched).toBe(1);
      expect(fc.planning.awaitingApproval).toBe(2);
      expect(fc.planning.roadmap.map((r: { id: string }) => r.id)).toEqual([item1Id, item2Id, item3Id]);
      expect(fc.planning.roadmap[0]).toMatchObject({
        status: "dispatched",
        source: "growth",
        evidenceRef: "growth-exp:7",
      });
      expect(fc.planning.roadmap[1]).toMatchObject({ isPivot: true, awaitingApproval: true });

      // (7) tenant isolation: the sibling workspace sees an empty backlog + empty roadmap, and ticking it
      // does nothing to w's data.
      const otherBacklog = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${other.workspaceId}/planning/backlog`,
          cookies: { rid: other.cookie },
        })
      ).json();
      expect(otherBacklog).toEqual([]);
      const otherTick = (await tick(other)).json();
      expect(otherTick.actions).toEqual([]);
      const otherRows = await db
        .select()
        .from(backlogItems)
        .where(eq(backlogItems.workspaceId, other.workspaceId));
      expect(otherRows).toHaveLength(0);
    },
  );

  it("ingests real user feedback into a triaged backlog item without manual copy-paste (#623)", async () => {
    const w = await seed();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/planning/feedback`,
      cookies: { rid: w.cookie },
      payload: {
        channel: "support",
        reporter: "dana@northwind.co",
        url: "https://helpdesk.local/tickets/42",
        text: "The checkout is broken and we cannot pay for the team plan.",
      },
    });

    expect(res.statusCode).toBe(201);
    const item = res.json();
    expect(item).toMatchObject({
      workspaceId: w.workspaceId,
      source: "customer_voice",
      sourceRef: "feedback:support:the-checkout-is-broken-and-we-cannot-pay-for-th",
      status: "proposed",
      reach: 1,
      impact: 3,
      confidencePct: 100,
      effort: 2,
    });
    expect(item.title).toContain("checkout is broken");
    expect(item.description).toContain("Reporter: dana@northwind.co");
    expect(item.description).toContain("Receipt: https://helpdesk.local/tickets/42");

    const backlog = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/planning/backlog`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(backlog).toHaveLength(1);
    expect(backlog[0]).toMatchObject({ item: { id: item.id, source: "customer_voice" }, position: 1 });

    const invalid = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/planning/feedback`,
      cookies: { rid: w.cookie },
      payload: { channel: "slack", text: "please add this" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("is a no-op when planning is disabled (default-OFF): no spec drafted, no launch", async () => {
    const w = await seed();
    await addItem(w, {
      title: "Anything",
      source: "manual",
      evidence: { signalCount: 10, severityTier: 1, corroboratingSources: 1, effortPoints: 1 },
    });
    const disabled = makePlanning(false);
    const before = launches.length;
    const result = await disabled.tick(w.workspaceId);
    expect(result.skipped).toBe("disabled");
    expect(result.actions).toEqual([]);
    expect(launches.length).toBe(before);
    expect(await listPlanningSpecs(w.workspaceId)).toEqual([]);
  });
});
