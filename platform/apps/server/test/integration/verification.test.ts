import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, approvalRequests, verificationVerdicts } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { definitionStore, verdictStore } from "../../src/db/repositories/verification.js";
import { VERIFICATION_DEFAULTS } from "../../src/verification/caps.js";
import {
  VerificationEngine,
  type Deliverable,
  type IndependentGrader,
  type VerificationApprovalSink,
  type WorkerFeedback,
} from "../../src/verification/engine.js";
import type { CheckObservation } from "../../src/verification/types.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

/**
 * Integration (#191): the real VerificationEngine over the real `verification_criteria` /
 * `verification_verdicts` repos + the real #13 `createRequest`. Proves, end-to-end against Postgres:
 *  - `defineDone` persists the definition of done (visible via the read route);
 *  - a verified reversible deliverable opens a real #13 approval card with the per-check PROOF;
 *  - a failed verification returns to the worker (fail→fix) and persists, opening no card;
 *  - the read route returns verdicts tenant-scoped.
 */

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const app: FastifyInstance = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  workerMemberId: string;
  graderMemberId: string;
  cookie: string;
}

async function seed(): Promise<World> {
  const slug = `verifn-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const worker = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Worker" },
  });
  const grader = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Grader" },
  });
  return {
    workspaceId: me.workspaceId,
    workerMemberId: worker.json().memberId,
    graderMemberId: grader.json().memberId,
    cookie,
  };
}

/** An engine over the REAL stores + a REAL #13 sink, with an injectable grader. */
function engineFor(
  world: World,
  grader: IndependentGrader,
  caps: Partial<typeof VERIFICATION_DEFAULTS> = {},
): VerificationEngine {
  const approvals: VerificationApprovalSink = {
    requestApproval: async ({ workspaceId, deliverable, dod, verdict, reason }) => {
      const req = await createRequest({
        workspaceId,
        requesterMemberId: world.workerMemberId,
        actionType: "verification.review",
        payload: {
          deliverableRef: deliverable.deliverableRef,
          criteria: dod.criteria,
          checks: verdict.checks,
          confidence: verdict.confidence,
        },
        amount: null,
        summary: reason,
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested" }],
      });
      return { id: req.id };
    },
    escalate: async ({ workspaceId, deliverable, reason }) => {
      const req = await createRequest({
        workspaceId,
        requesterMemberId: world.workerMemberId,
        actionType: "verification.escalated",
        payload: { deliverableRef: deliverable.deliverableRef },
        amount: null,
        summary: reason,
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested" }],
      });
      return { id: req.id };
    },
  };
  const feedback: WorkerFeedback = { returnToWorker: async () => {} };
  return new VerificationEngine({
    definitions: definitionStore,
    verdicts: verdictStore,
    grader,
    approvals,
    feedback,
    caps: () => ({ ...VERIFICATION_DEFAULTS, enabled: true, ...caps }),
    killSwitch: async () => false,
    redact: (t) => t,
    logger: silentLogger,
  });
}

const passingGrader = (graderMemberId: string): IndependentGrader => ({
  grade: async ({ dod }) => ({
    graderMemberId,
    observations: dod.criteria.map(
      (c): CheckObservation => ({
        criterionId: c.id,
        satisfied: true,
        confidence: 0.95,
        evidence: `met ${c.id}`,
        productionGrounded: c.category === "production",
      }),
    ),
  }),
});

const failingGrader = (graderMemberId: string): IndependentGrader => ({
  grade: async ({ dod }) => ({
    graderMemberId,
    observations: dod.criteria.map(
      (c): CheckObservation => ({
        criterionId: c.id,
        satisfied: false,
        confidence: 0.9,
        evidence: `missed ${c.id}`,
        productionGrounded: false,
      }),
    ),
  }),
});

const deliverable = (world: World, ref: string): Deliverable => ({
  workspaceId: world.workspaceId,
  deliverableRef: ref,
  deliverableKind: "support_reply",
  workerMemberId: world.workerMemberId,
  content: "Here is the support reply.",
});

describe("deliverable verification layer — proof + #13 card (integration)", () => {
  it("defineDone persists the definition of done, readable via the route (AC #1)", async () => {
    const world = await seed();
    const ref = `deliv-${newId()}`;
    await engineFor(world, passingGrader(world.graderMemberId)).defineDone({
      workspaceId: world.workspaceId,
      deliverableRef: ref,
      deliverableKind: "support_reply",
      brief: "Answer the refund question accurately and kindly.",
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${world.workspaceId}/verification/criteria/${ref}`,
      cookies: { rid: world.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { definition: { criteria: unknown[]; reversibility: string } };
    expect(body.definition.criteria.length).toBeGreaterThan(0);
    expect(body.definition.reversibility).toBe("reversible");
  });

  it("a verified reversible deliverable opens a real #13 card carrying the proof (AC #2,#4)", async () => {
    const world = await seed();
    const ref = `deliv-${newId()}`;
    const result = await engineFor(world, passingGrader(world.graderMemberId)).verify(deliverable(world, ref));
    expect("decision" in result && result.decision.action).toBe("request_approval");
    if (!("record" in result)) throw new Error("expected a verdict record");

    // the durable verdict carries the proof
    const [verdict] = await db
      .select()
      .from(verificationVerdicts)
      .where(eq(verificationVerdicts.id, result.record.id));
    expect(verdict.passed).toBe(true);
    expect(verdict.independenceOk).toBe(true);
    expect(verdict.status).toBe("request_approval");

    // and links to a real pending #13 approval request showing the criteria + per-check proof
    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.id, result.approvalRequestId!),
          eq(approvalRequests.workspaceId, world.workspaceId),
        ),
      );
    expect(req.actionType).toBe("verification.review");
    expect(req.status).toBe("pending");
    const payload = req.payload as { checks: unknown[]; criteria: unknown[] };
    expect(payload.criteria.length).toBeGreaterThan(0);
    expect(payload.checks.length).toBeGreaterThan(0);
  });

  it("a failed verification returns to the worker (fail→fix) and opens no card (AC #3)", async () => {
    const world = await seed();
    const ref = `deliv-${newId()}`;
    const result = await engineFor(world, failingGrader(world.graderMemberId)).verify(deliverable(world, ref));
    expect("decision" in result && result.decision.action).toBe("return_to_worker");
    if (!("record" in result)) throw new Error("expected a verdict record");
    expect(result.approvalRequestId).toBeNull();
    expect(result.record.passed).toBe(false);

    // read route returns the verdict, tenant-scoped
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${world.workspaceId}/verification/verdicts`,
      cookies: { rid: world.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verdicts: Array<{ id: string; status: string }> };
    expect(body.verdicts.find((v) => v.id === result.record.id)?.status).toBe("return_to_worker");
  });

  it("the read route is tenant-scoped (a stranger cannot read another workspace's verdicts)", async () => {
    const owner = await seed();
    const stranger = await seed();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/verification/verdicts`,
      cookies: { rid: stranger.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
