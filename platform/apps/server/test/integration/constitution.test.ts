import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, constitutionViolations } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { VentureService, type ConstitutionGuard, type ConstitutionEvidence } from "../../src/venture/service.js";
import { ventureRepo } from "../../src/venture/default.js";
import { VENTURE_DEFAULTS } from "../../src/venture/caps.js";
import { CONSTITUTION_DEFAULTS } from "../../src/constitution/caps.js";
import { recordViolation } from "../../src/db/repositories/constitution.js";
import { RUBRIC_DIMENSIONS, type PersonaScorecard } from "../../src/venture/rubric.js";
import { createTask } from "../../src/db/repositories/tasks.js";

function uniform(value: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, value])) as PersonaScorecard;
}

// Controllable knobs the tests set before driving a route.
let scoreValue = 8; // → 80, a FUND-worthy base score
let evidence: ConstitutionEvidence = {
  unaffiliatedPayingIntentSignals: 0,
  externalDemandPresent: false,
  paidSignalPresent: false,
};
let approvalCount = 0;

// A real constitution guard wired to the REAL violations table (enabled) but with controllable
// evidence, so we can prove the love-gate blocks + flags end-to-end against Postgres.
const guard: ConstitutionGuard = {
  enabled: () => true,
  caps: () => ({ ...CONSTITUTION_DEFAULTS, enabled: true }),
  evidenceFor: async () => evidence,
  record: async ({ workspaceId, ideaId, verdict, violations }) => {
    for (const v of violations) {
      await recordViolation({ workspaceId, ideaId, verdict, violation: v });
    }
  },
};

const service = new VentureService({
  repo: ventureRepo,
  evidence: { gather: async () => [{ claim: "TAM is large", source: null, assumption: true }] },
  scorer: { score: async () => ({ advocate: uniform(scoreValue), reviewer: uniform(scoreValue) }) },
  approvals: {
    enqueue: async () => {
      approvalCount++;
      return { id: "appr" };
    },
  },
  memory: { record: async () => ({ id: "mem" }) },
  epics: {
    emit: async ({ workspaceId, idea, createdByMemberId }) => {
      const task = await createTask({ workspaceId, title: `epic: ${idea.problem}`, createdByMemberId });
      return { id: task.id };
    },
  },
  caps: () => VENTURE_DEFAULTS,
  constitution: guard,
  now: () => new Date("2026-06-10T00:00:00Z"),
});

const app = buildApp({ venture: service });
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const post = (url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "POST", url, cookies: { rid: cookie }, payload: payload as object });
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, cookies: { rid: cookie } });

async function seed(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `co-${newId()}`;
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

async function openViolations(workspaceId: string) {
  return db
    .select()
    .from(constitutionViolations)
    .where(
      and(
        eq(constitutionViolations.workspaceId, workspaceId),
        eq(constitutionViolations.status, "open"),
      ),
    );
}

const B2B_IDEA = { problem: "p", targetUser: "u", insight: "i", wedge: "w", marketPath: "m", segment: "b2b" };

describe("constitution enforcement (integration)", () => {
  it("Article I: a B2B FUND with no demand evidence is BLOCKED (→ESCALATE) and FLAGGED", async () => {
    const { cookie, workspaceId } = await seed();
    scoreValue = 8; // → 80, base verdict FUND
    evidence = { unaffiliatedPayingIntentSignals: 0, externalDemandPresent: false, paidSignalPresent: false };
    approvalCount = 0;

    const submitted = await post(`/workspaces/${workspaceId}/ventures`, cookie, B2B_IDEA);
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().segment).toBe("b2b");
    const vid = submitted.json().id as string;

    await post(`/workspaces/${workspaceId}/ventures/${vid}/score`, cookie);
    const decided = await post(`/workspaces/${workspaceId}/ventures/${vid}/decide`, cookie);

    // BLOCKED: a FUND-worthy score did NOT fund — it was downgraded to a human-routed ESCALATE.
    expect(decided.statusCode).toBe(200);
    expect(decided.json().verdict).toBe("ESCALATE");
    expect(approvalCount).toBe(1); // escalated to the owner (the flag's escalation)

    const view = await get(`/workspaces/${workspaceId}/ventures/${vid}`, cookie);
    expect(view.json().idea.status).toBe("escalated");
    expect(view.json().latestScorecard.funded).toBe(false);

    // FLAGGED: the durable violation feed has the love-paradigm violation (SOURCE early-warning + FUND).
    const rows = await openViolations(workspaceId);
    const codes = rows.map((r) => r.code);
    expect(codes).toContain("love_paradigm_unmet");
    const loveRow = rows.find((r) => r.code === "love_paradigm_unmet")!;
    expect(loveRow.article).toBe("I");
    expect(loveRow.severity).toBe("block");
    expect(loveRow.stage).toBe("FUND");
  });

  it("does NOT weaken existing gates: a B2B FUND WITH ≥10 unaffiliated paying-intent signals still FUNDs", async () => {
    const { cookie, workspaceId } = await seed();
    scoreValue = 8;
    evidence = { unaffiliatedPayingIntentSignals: 12, externalDemandPresent: true, paidSignalPresent: true };

    const vid = (await post(`/workspaces/${workspaceId}/ventures`, cookie, B2B_IDEA)).json().id;
    await post(`/workspaces/${workspaceId}/ventures/${vid}/score`, cookie);
    const decided = await post(`/workspaces/${workspaceId}/ventures/${vid}/decide`, cookie);

    expect(decided.json().verdict).toBe("FUND");
    expect((await get(`/workspaces/${workspaceId}/ventures/${vid}`, cookie)).json().idea.status).toBe("funded");
    // No FUND-stage violation was recorded (the FUND was constitution-clean).
    const codes = (await openViolations(workspaceId)).filter((r) => r.stage === "FUND").map((r) => r.code);
    expect(codes).toHaveLength(0);
  });

  it("a B2C FUND on synthetic demand still FUNDs but is flagged (flag-only, Article V/VIII)", async () => {
    const { cookie, workspaceId } = await seed();
    scoreValue = 8;
    evidence = { unaffiliatedPayingIntentSignals: 0, externalDemandPresent: false, paidSignalPresent: false };

    const idea = { ...B2B_IDEA, segment: "b2c" };
    const vid = (await post(`/workspaces/${workspaceId}/ventures`, cookie, idea)).json().id;
    await post(`/workspaces/${workspaceId}/ventures/${vid}/score`, cookie);
    const decided = await post(`/workspaces/${workspaceId}/ventures/${vid}/decide`, cookie);

    expect(decided.json().verdict).toBe("FUND"); // love-gate is B2B-only → verdict unchanged
    const codes = (await openViolations(workspaceId)).filter((r) => r.stage === "FUND").map((r) => r.code);
    expect(codes).toContain("funded_on_synthetic_demand");
    expect(codes).not.toContain("love_paradigm_unmet");
  });
});
