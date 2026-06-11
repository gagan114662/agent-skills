import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, approvalRequests, verifierResults } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { verifierResultStore } from "../../src/db/repositories/verifier-results.js";
import { VerifierRunner, type VerifierEscalator } from "../../src/verifiers/engine.js";
import { VERIFIER_DEFAULTS } from "../../src/verifiers/caps.js";
import type { Observation, ObservationError, VerifierClaim } from "../../src/verifiers/types.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

/**
 * Integration (#106): the real VerifierRunner over the real `verifier_results` repo + the real #13
 * `createRequest`. Proves the durable evidence row and — for a measured FAILURE — the linked escalation
 * (never silently passes), end-to-end against Postgres; and that the read route returns them
 * tenant-scoped.
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
  agentMemberId: string;
  cookie: string;
}

async function seed(): Promise<World> {
  const slug = `verif-${newId()}`;
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
    payload: { name: "Verifier" },
  });
  return { workspaceId: me.workspaceId, agentMemberId: agent.json().memberId, cookie };
}

/** A runner over the REAL store + a REAL #13 escalator (createRequest), with a fixed observation. */
function runnerFor(world: World, observation: Observation | ObservationError): VerifierRunner {
  const escalator: VerifierEscalator = {
    escalate: async ({ workspaceId, claim, outcome }) => {
      const req = await createRequest({
        workspaceId,
        requesterMemberId: world.agentMemberId,
        actionType: "verifier.failed",
        payload: { kind: claim.kind, claimRef: claim.claimRef },
        amount: null,
        summary: `Outcome verifier FAILED: ${claim.kind} for ${claim.claimRef} — ${outcome.detail}.`,
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested", detail: { kind: claim.kind } }],
      });
      return { id: req.id };
    },
  };
  return new VerifierRunner({
    observations: { observe: async () => observation },
    results: verifierResultStore,
    escalator,
    claims: { listDue: async () => [] },
    caps: () => ({ ...VERIFIER_DEFAULTS, enabled: true }),
    killSwitch: async () => false,
    activeWorkspaces: async () => [world.workspaceId],
    redact: (t) => t,
    logger: silentLogger,
  });
}

describe("outcome verifiers — durable evidence + escalation (integration)", () => {
  it("a failed deploy_live writes a 'failed' row linked to a real #13 approval request", async () => {
    const world = await seed();
    const claim: VerifierClaim = {
      workspaceId: world.workspaceId,
      kind: "deploy_live",
      claimRef: "https://down.example.com",
      target: 200,
      source: "deploy",
    };
    const runner = runnerFor(world, { kind: "deploy_live", httpStatus: 503, healthy: false });

    const { record, action } = await runner.verify(claim);
    expect(action).toBe("escalate");
    expect(record.status).toBe("failed");
    expect(record.escalationRequestId).not.toBeNull();

    // the persisted row exists
    const [persisted] = await db
      .select()
      .from(verifierResults)
      .where(eq(verifierResults.id, record.id));
    expect(persisted.status).toBe("failed");

    // and is linked to a real pending approval request
    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.id, record.escalationRequestId!),
          eq(approvalRequests.workspaceId, world.workspaceId),
        ),
      );
    expect(req.actionType).toBe("verifier.failed");
    expect(req.status).toBe("pending");
  });

  it("a passing revenue_real writes a 'passed' row with no approval, and the read route returns it", async () => {
    const world = await seed();
    const claim: VerifierClaim = {
      workspaceId: world.workspaceId,
      kind: "revenue_real",
      claimRef: `venture-${newId()}`,
      target: 1,
      source: "billing",
    };
    const runner = runnerFor(world, { kind: "revenue_real", realEventCount: 3 });

    const { record, action } = await runner.verify(claim);
    expect(action).toBe("record_pass");
    expect(record.status).toBe("passed");
    expect(record.escalationRequestId).toBeNull();

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${world.workspaceId}/verifier-results`,
      cookies: { rid: world.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ id: string; kind: string; status: string }> };
    const found = body.results.find((r) => r.id === record.id);
    expect(found).toMatchObject({ kind: "revenue_real", status: "passed" });
  });

  it("the read route is tenant-scoped (a stranger cannot read another workspace's verdicts)", async () => {
    const owner = await seed();
    const stranger = await seed();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/verifier-results`,
      cookies: { rid: stranger.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
