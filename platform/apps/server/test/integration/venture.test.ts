import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { VentureService } from "../../src/venture/service.js";
import { ventureRepo } from "../../src/venture/default.js";
import { VentureAdmission, VentureAdmissionError } from "../../src/venture/admission.js";
import { VENTURE_DEFAULTS } from "../../src/venture/caps.js";
import { RUBRIC_DIMENSIONS, type PersonaScorecard } from "../../src/venture/rubric.js";
import { createTask } from "../../src/db/repositories/tasks.js";
import { getUsage, recordSessionCompute } from "../../src/db/repositories/tenant-usage.js";
import { windowKey } from "../../src/scale/usage.js";

function uniform(value: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, value])) as PersonaScorecard;
}

// A controllable scorer: the test sets `scoreValue` before driving a route.
let scoreValue = 8;
const service = new VentureService({
  repo: ventureRepo,
  evidence: { gather: async () => [{ claim: "TAM is large", source: null, assumption: true }] },
  scorer: { score: async () => ({ advocate: uniform(scoreValue), reviewer: uniform(scoreValue) }) },
  approvals: { enqueue: async () => ({ id: "appr" }) },
  memory: { record: async () => ({ id: "mem" }) },
  // Emit a REAL task so the FUND path's `epic_task_id` FK (a uuid) resolves against a real row.
  epics: {
    emit: async ({ workspaceId, idea, createdByMemberId }) => {
      const task = await createTask({ workspaceId, title: `epic: ${idea.problem}`, createdByMemberId });
      return { id: task.id };
    },
  },
  caps: () => VENTURE_DEFAULTS,
  now: () => new Date("2026-06-10T00:00:00Z"),
});

const app = buildApp({ venture: service });

// A second app whose service has a real tenant-usage meter + a low dollar budget, to prove the
// budget-exhaust → 402 route semantics end-to-end against real `tenant_usage` accounting (#71).
const budgetedService = new VentureService({
  repo: ventureRepo,
  evidence: { gather: async () => [] },
  scorer: { score: async () => ({ advocate: uniform(5), reviewer: uniform(5) }) }, // → 50, ITERATE
  approvals: { enqueue: async () => ({ id: "appr" }) },
  memory: { record: async () => ({ id: "mem" }) },
  epics: {
    emit: async ({ workspaceId, idea, createdByMemberId }) => {
      const t = await createTask({ workspaceId, title: `epic: ${idea.problem}`, createdByMemberId });
      return { id: t.id };
    },
  },
  caps: () => ({ ...VENTURE_DEFAULTS, evaluationCostCents: 100 }),
  usage: {
    spentCents: async (wid, now) => (await getUsage(wid, windowKey(now))).estimatedCostCents,
    charge: async (wid, cents, now) => {
      if (cents > 0) await recordSessionCompute(wid, windowKey(now), 0, cents);
    },
  },
  scaleBudgetCents: () => 150, // budget = 150¢; each pass costs 100¢ → exhausts on the 2nd pass
  now: () => new Date("2026-06-10T00:00:00Z"),
});
const budgetedApp = buildApp({ venture: budgetedService });
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await budgetedApp.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const post = (url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "POST", url, cookies: { rid: cookie }, payload: payload as object });
const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, cookies: { rid: cookie } });

async function seed(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `ve-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get("/me", cookie)).json();
  return { cookie, workspaceId: me.workspaceId };
}

const IDEA = { problem: "p", targetUser: "u", insight: "i", wedge: "w", marketPath: "m" };

describe("venture routes + admission gate (integration)", () => {
  it("submits, scores, decides (FUND), and gets a full venture view", async () => {
    const { cookie, workspaceId } = await seed();
    scoreValue = 8; // → 80, FUND

    const submitted = await post(`/workspaces/${workspaceId}/ventures`, cookie, IDEA);
    expect(submitted.statusCode).toBe(201);
    const vid = submitted.json().id as string;

    const scored = await post(`/workspaces/${workspaceId}/ventures/${vid}/score`, cookie);
    expect(scored.statusCode).toBe(200);
    expect(scored.json().score).toBe(80);

    const decided = await post(`/workspaces/${workspaceId}/ventures/${vid}/decide`, cookie);
    expect(decided.statusCode).toBe(200);
    expect(decided.json().verdict).toBe("FUND");

    const view = await get(`/workspaces/${workspaceId}/ventures/${vid}`, cookie);
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body.idea.status).toBe("funded");
    expect(body.latestScorecard.verdict).toBe("FUND");
    expect(body.latestScorecard.funded).toBe(true);
    expect(body.iterations.length).toBeGreaterThanOrEqual(1);
  });

  it("KILLs a weak idea (verdict persisted, no funded scorecard produced)", async () => {
    const { cookie, workspaceId } = await seed();
    scoreValue = 3; // → 30, KILL

    const vid = (await post(`/workspaces/${workspaceId}/ventures`, cookie, IDEA)).json().id;
    await post(`/workspaces/${workspaceId}/ventures/${vid}/score`, cookie);
    const decided = await post(`/workspaces/${workspaceId}/ventures/${vid}/decide`, cookie);
    expect(decided.json().verdict).toBe("KILL");

    // No passing scorecard was minted for this workspace.
    expect(await ventureRepo.hasPassingUnexpiredScorecard(workspaceId, new Date("2026-06-10T00:00:00Z"))).toBe(
      false,
    );
  });

  it("admission: a FUND makes the gate admit; an enabled workspace with none is blocked; default-off admits", async () => {
    const now = () => new Date("2026-06-10T00:00:00Z");

    // Workspace A: fund an idea → has a passing unexpired scorecard.
    const a = await seed();
    scoreValue = 9;
    const avid = (await post(`/workspaces/${a.workspaceId}/ventures`, a.cookie, IDEA)).json().id;
    await post(`/workspaces/${a.workspaceId}/ventures/${avid}/score`, a.cookie);
    await post(`/workspaces/${a.workspaceId}/ventures/${avid}/decide`, a.cookie);

    // Workspace B: enabled gate but never funded anything.
    const b = await seed();

    // Gate enabled for BOTH A and B; disabled is the default for any other workspace.
    const gate = new VentureAdmission({
      config: (wid) => ({ enabled: wid === a.workspaceId || wid === b.workspaceId }),
      hasPassingUnexpired: (wid, atNow) => ventureRepo.hasPassingUnexpiredScorecard(wid, atNow),
      now,
    });

    // A funded → admitted; B enabled+empty → blocked; isolation: A's state never unblocks B.
    await expect(gate.check(a.workspaceId)).resolves.toBeUndefined();
    await expect(gate.check(b.workspaceId)).rejects.toBeInstanceOf(VentureAdmissionError);

    // Default-off: a gate that's disabled for B admits even with no scorecard (unchanged behavior).
    const offGate = new VentureAdmission({
      config: () => ({ enabled: false }),
      hasPassingUnexpired: (wid, atNow) => ventureRepo.hasPassingUnexpiredScorecard(wid, atNow),
      now,
    });
    await expect(offGate.check(b.workspaceId)).resolves.toBeUndefined();
  });

  it("advance route returns 402 when an evaluation exhausts the tenant dollar budget (#71 semantics)", async () => {
    const { cookie, workspaceId } = await seed();
    const bPost = (url: string, p?: unknown) =>
      budgetedApp.inject({ method: "POST", url, cookies: { rid: cookie }, payload: p as object });

    const vid = (await bPost(`/workspaces/${workspaceId}/ventures`, IDEA)).json().id;

    // First advance charges 100¢ (< 150) → ITERATE, 200.
    const first = await bPost(`/workspaces/${workspaceId}/ventures/${vid}/advance`);
    expect(first.statusCode).toBe(200);
    expect(first.json().verdict).toBe("ITERATE");

    // Second advance charges another 100¢ (→ 200 ≥ 150) → terminates ESCALATE, answered 402.
    const second = await bPost(`/workspaces/${workspaceId}/ventures/${vid}/advance`);
    expect(second.statusCode).toBe(402);
    expect(second.json().verdict).toBe("ESCALATE");
    expect(second.json().budgetExhausted).toBe(true);
  });

  it("is tenant-isolated: one workspace cannot read another's venture", async () => {
    const a = await seed();
    const b = await seed();
    const vid = (await post(`/workspaces/${a.workspaceId}/ventures`, a.cookie, IDEA)).json().id;

    // B's cookie against A's workspace path → 403 (the #19 assertWorkspace boundary).
    const cross = await get(`/workspaces/${a.workspaceId}/ventures/${vid}`, b.cookie);
    expect(cross.statusCode).toBe(403);
  });
});
