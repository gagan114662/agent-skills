import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, venturePlans } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  VentureMemoryService,
  ventureEntity,
  ventureMemoryContent,
  ventureMemoryDedupeKey,
} from "../../src/venture-memory/service.js";
import { VENTURE_MEMORY_DEFAULTS, type VentureMemoryCaps } from "../../src/venture-memory/caps.js";
import { VENTURE_WEEKLY_PLAN_ACTION } from "../../src/venture-memory/executor.js";
import { upsertMemory } from "../../src/db/repositories/memories.js";
import {
  listVentureMemoryNodes,
  insertOkr,
  listOkrsForVenture,
  upsertPlan,
  updatePlan,
  upsertPlaybook,
  listPlaybooks,
} from "../../src/db/repositories/venture-memory.js";
import {
  createIdea,
  getOrCreateEvaluation,
  listEvaluations,
  listActiveEvaluationWorkspaces,
  latestScorecard,
} from "../../src/db/repositories/venture.js";
import { recordVerifierResult, listVerifierResults } from "../../src/db/repositories/verifier-results.js";
import { listBacklogItems } from "../../src/db/repositories/planning.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { listWorkspaceMembers } from "../../src/db/repositories/members.js";

/**
 * Venture Memory & Planning end-to-end (#197, ADR-0197) against REAL Postgres: per-venture memory
 * (reusing the #15 graph) + OKR drift retrieved into a session brief; a weekly tick that drafts a plan
 * citing #200 (verified-metric go/no-go, UNVERIFIED estimates), gates it via a REAL #13 request, and —
 * on the owner's approval through the REAL approvals route + executor registry — flows the plan's items
 * into the #115 backlog. Caps forced ON (default is OFF); the plan approval's requester is the venture's
 * AGENT member so the human owner can approve it (not their own request).
 */
function makeVentureMemory(enabled: boolean): VentureMemoryService {
  const caps: VentureMemoryCaps = { ...VENTURE_MEMORY_DEFAULTS, enabled };
  return new VentureMemoryService({
    caps: () => caps,
    memory: {
      record: async (input) =>
        upsertMemory({
          workspaceId: input.workspaceId,
          type: "venture_memory",
          entity: ventureEntity(input.ideaId),
          content: ventureMemoryContent({
            kind: input.kind,
            text: input.text,
            why: input.why ?? null,
            sourceRef: input.sourceRef ?? null,
          }),
          dedupeKey: ventureMemoryDedupeKey(input.ideaId, input.kind, input.text),
          sourceType: "manual",
          createdByMemberId: input.createdByMemberId ?? null,
        }),
      nodes: (workspaceId, ideaId, includeStale) =>
        listVentureMemoryNodes(workspaceId, ventureEntity(ideaId), includeStale),
    },
    okrs: { insert: insertOkr, listForVenture: listOkrsForVenture },
    plans: {
      upsert: upsertPlan,
      linkApproval: (workspaceId, id, approvalRequestId, now) =>
        updatePlan(workspaceId, id, { approvalRequestId }, now),
    },
    playbooks: { upsert: upsertPlaybook, list: listPlaybooks },
    ventures: {
      ventures: async (workspaceId) =>
        (await listEvaluations(workspaceId)).map((e) => ({ ideaId: e.ideaId, category: null })),
    },
    scorecard: {
      verifiedMetricCount: async (workspaceId, ideaId) => {
        const passed = await listVerifierResults(workspaceId, { status: "passed", limit: 200 });
        return passed.filter((r) => r.claimRef.includes(ideaId)).length;
      },
      latestScore: async (workspaceId, ideaId) =>
        (await latestScorecard(workspaceId, ideaId))?.score ?? null,
    },
    backlog: {
      openTitles: async (workspaceId, ideaId) =>
        (await listBacklogItems(workspaceId, ["proposed", "specced", "dispatched"]))
          .filter((b) => b.ideaId === ideaId)
          .map((b) => b.title),
    },
    approvals: {
      enqueue: async ({ workspaceId, plan }) => {
        const members = await listWorkspaceMembers(workspaceId);
        const agent = members.find((m) => m.kind === "agent") ?? members[0]!;
        const req = await createRequest({
          workspaceId,
          requesterMemberId: agent.id, // an agent requester ⇒ the human owner may approve it
          actionType: VENTURE_WEEKLY_PLAN_ACTION,
          payload: { planId: plan.id, ideaId: plan.ideaId, weekKey: plan.weekKey },
          amount: null,
          summary: `Weekly plan for ${plan.ideaId} — ${plan.goNoGo}. ${plan.rationale}`,
          status: "pending",
          expiresAt: null,
          events: [{ type: "requested", detail: { planId: plan.id } }],
        });
        return { id: req.id };
      },
    },
    killSwitch: async () => false,
    activeWorkspaces: listActiveEvaluationWorkspaces,
  });
}

const app: FastifyInstance = buildApp({ ventureMemory: makeVentureMemory(true) });
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  cookie: string;
  agentMemberId: string;
  ideaId: string;
}

async function seed(): Promise<World> {
  const slug = `vm-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Founder Agent" },
  });
  // a venture the weekly tick will plan over (an idea + its durable evaluation).
  const idea = await createIdea({
    workspaceId: me.workspaceId,
    problem: "p",
    targetUser: "t",
    insight: "i",
    wedge: "w",
    marketPath: "m",
    createdByMemberId: me.memberId,
  });
  await getOrCreateEvaluation(me.workspaceId, idea.id);
  return { workspaceId: me.workspaceId, cookie, agentMemberId: agent.json().memberId, ideaId: idea.id };
}

const url = (w: World, path: string): string => `/workspaces/${w.workspaceId}/ventures/${w.ideaId}${path}`;

describe("venture memory & planning (real Postgres): memory → brief → weekly plan → #13 → dispatch", () => {
  it(
    "records venture memory + OKRs, injects them into the brief, drafts a #200-citing weekly plan, gates " +
      "it via #13, and on owner approval flows the items into the #115 backlog — tenant-isolated",
    async () => {
      const w = await seed();
      const other = await seed();

      // (1) record a customer-voice memory + two OKRs (one UNVERIFIED, one verified-but-behind).
      const mem = await app.inject({
        method: "POST",
        url: url(w, "/memory"),
        cookies: { rid: w.cookie },
        payload: { kind: "customer_voice", text: "users want CSV export", sourceRef: "msg:1" },
      });
      expect(mem.statusCode).toBe(201);

      const badKind = await app.inject({
        method: "POST",
        url: url(w, "/memory"),
        cookies: { rid: w.cookie },
        payload: { kind: "vibes", text: "x" },
      });
      expect(badKind.statusCode).toBe(400);

      const okr = await app.inject({
        method: "POST",
        url: url(w, "/okrs"),
        cookies: { rid: w.cookie },
        payload: {
          objective: "Reach product-market fit",
          keyResults: [
            { metric: "MRR", target: 1000, current: 200, unit: "usd", verified: false, source: null },
            { metric: "retention", target: 80, current: 20, unit: "pct", verified: true, source: "vr_x" },
          ],
        },
      });
      expect(okr.statusCode).toBe(201);

      // (2) the brief (AC1) injects memory + OKR drift; the OKR drift flags the unverified KR.
      const brief = (await app.inject({ method: "GET", url: url(w, "/brief"), cookies: { rid: w.cookie } })).json();
      expect(brief.text).toContain("Venture memory");
      expect(brief.text).toContain("users want CSV export");
      expect(brief.text).toContain("OKRs");
      expect(brief.text).toContain("DRIFT");

      // (3) the OKR drift surface (AC4): the unverified KR can NEVER read on_track.
      const drift = (await app.inject({ method: "GET", url: url(w, "/okrs"), cookies: { rid: w.cookie } })).json();
      const mrr = drift[0].keyResults.find((k: { metric: string }) => k.metric === "MRR");
      expect(mrr.status).toBe("unverified");

      // (4) the "what does it believe" audit (AC5): the fresh belief is the recorded memory.
      const beliefs = (await app.inject({ method: "GET", url: url(w, "/beliefs"), cookies: { rid: w.cookie } })).json();
      expect(beliefs.fresh.map((e: { text: string }) => e.text)).toContain("users want CSV export");

      // (5) an externally-verified (#106) receipt for the venture flips the go/no-go to GO.
      await recordVerifierResult({
        workspaceId: w.workspaceId,
        kind: "revenue_real",
        claimRef: w.ideaId,
        status: "passed",
        measuredValue: 1,
        threshold: 0,
        detail: "stripe receipt",
        now: new Date(),
      });

      // (6) the weekly tick drafts + #13-gates the plan (default-OFF; caps forced ON here).
      const tick = (
        await app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/ventures/planning/tick`, cookies: { rid: w.cookie } })
      ).json();
      expect(tick.skipped).toBeUndefined();
      expect(tick.actions).toHaveLength(1);
      const action = tick.actions[0];
      expect(action.ideaId).toBe(w.ideaId);
      expect(action.goNoGo).toBe("go");
      expect(action.itemCount).toBeGreaterThan(0);
      expect(action.approvalRequestId).toBeTruthy();

      // (7) the persisted plan cites #200 + labels every estimate UNVERIFIED (premortem, structurally).
      const [planRow] = await db
        .select()
        .from(venturePlans)
        .where(and(eq(venturePlans.workspaceId, w.workspaceId), eq(venturePlans.ideaId, w.ideaId)));
      expect(planRow.premortemCited).toBe(true);
      expect(planRow.rationale).toContain("#200");
      expect(planRow.status).toBe("draft");
      expect(planRow.items.every((i: { estimateLabel: string }) => i.estimateLabel === "UNVERIFIED")).toBe(true);
      expect(planRow.approvalRequestId).toBe(action.approvalRequestId);

      // (8) the owner approves the #13 request → the executor flows items into the #115 backlog.
      const approve = await app.inject({
        method: "POST",
        url: `/approvals/${action.approvalRequestId}/approve`,
        cookies: { rid: w.cookie },
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().status).toBe("executed");

      const backlog = await listBacklogItems(w.workspaceId, ["proposed", "specced", "dispatched"]);
      const fromPlan = backlog.filter((b) => b.sourceRef === `venture-plan:${planRow.id}`);
      expect(fromPlan.length).toBe(planRow.items.length);
      expect(fromPlan.every((b) => b.ideaId === w.ideaId)).toBe(true);

      const [planAfter] = await db
        .select()
        .from(venturePlans)
        .where(and(eq(venturePlans.workspaceId, w.workspaceId), eq(venturePlans.id, planRow.id)));
      expect(planAfter.status).toBe("dispatched");

      // (9) tenant isolation: the sibling workspace sees none of w's memory / OKRs / plans.
      const otherMem = (await app.inject({ method: "GET", url: url(other, "/memory"), cookies: { rid: other.cookie } })).json();
      expect(otherMem).toEqual([]);
      const otherPlans = await db.select().from(venturePlans).where(eq(venturePlans.workspaceId, other.workspaceId));
      expect(otherPlans).toHaveLength(0);
    },
  );

  it("is a no-op when disabled (default-OFF): no plan drafted", async () => {
    const w = await seed();
    const disabled = makeVentureMemory(false);
    const result = await disabled.tick(w.workspaceId);
    expect(result.skipped).toBe("disabled");
    expect(result.actions).toEqual([]);
    const plans = await db.select().from(venturePlans).where(eq(venturePlans.workspaceId, w.workspaceId));
    expect(plans).toHaveLength(0);
  });
});
