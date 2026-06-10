import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  recordGateEvidence,
  recordBoundaryChange,
  listBoundaryChanges,
} from "../../src/db/repositories/gate-evidence.js";
import { upsertPolicy, listPolicies } from "../../src/db/repositories/approvals.js";
import { GatePricingService } from "../../src/gate-pricing/service.js";
import { GATE_PRICING_DEFAULTS } from "../../src/gate-pricing/caps.js";
import {
  readEvidenceWindow,
  listEvidenceActionTypes,
  ownedBoundaries,
} from "../../src/db/repositories/gate-evidence.js";
import { deletePolicy } from "../../src/db/repositories/approvals.js";
import type { Outcome } from "../../src/gate-pricing/pricing.js";

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newOwner(): Promise<Owner> {
  const slug = `gp-${newId()}`;
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

async function channelWithAgent(owner: Owner, agentMemberId: string): Promise<string> {
  const channel = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/channels`,
      cookies: { rid: owner.cookie },
      payload: { name: `c-${newId()}` },
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/channels/${channel.id}/grants`,
    cookies: { rid: owner.cookie },
    payload: { memberId: agentMemberId, capability: "write" },
  });
  return channel.id;
}

/** An evidence pricer over the REAL repos, but with the config gate forced ON (config is default-OFF). */
function pricer(): GatePricingService {
  return new GatePricingService({
    caps: () => ({ ...GATE_PRICING_DEFAULTS, enabled: true }),
    listActionTypes: listEvidenceActionTypes,
    readWindow: readEvidenceWindow,
    currentlyRelaxed: async (workspaceId, actionType) => {
      const rule = (await listPolicies(workspaceId)).find((p) => p.actionType === actionType);
      return { relaxed: !!rule && rule.requireApproval === false, ruleId: rule?.id ?? null };
    },
    relax: async (workspaceId, actionType) => {
      const rule = await upsertPolicy({
        workspaceId,
        actionType,
        requireApproval: false,
        maxAutoAmount: null,
        createdByMemberId: null,
      });
      return rule.id;
    },
    retighten: async (workspaceId, ruleId) => {
      await deletePolicy(ruleId, workspaceId);
    },
    audit: async (change) => {
      await recordBoundaryChange(change);
    },
  });
}

async function seedEvidence(workspaceId: string, actionType: string, outcomes: Outcome[]): Promise<void> {
  for (const outcome of outcomes) {
    await recordGateEvidence({
      workspaceId,
      actionType,
      outcome,
      editDistance: outcome === "edited" ? 3 : null,
      timeToDecisionMs: 1000,
      requestId: null,
      decidedByMemberId: null,
    });
  }
}

const approvals = (n: number): Outcome[] => Array<Outcome>(n).fill("approved");

describe("Evidence-Priced Autonomy (#119, integration, real Postgres)", () => {
  it("100 clean decisions → RELAX: a #95 rule is created, a RELAX audit row is written, the console surfaces it", async () => {
    const owner = await newOwner();
    await seedEvidence(owner.workspaceId, "chat.post_message", approvals(100));

    const applied = await pricer().tick(owner.workspaceId);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ actionType: "chat.post_message" });
    expect(applied[0].decision.recommendation).toBe("RELAX");

    // a #95 auto-approve rule now exists for the class
    const rule = (await listPolicies(owner.workspaceId)).find((p) => p.actionType === "chat.post_message");
    expect(rule).toBeDefined();
    expect(rule!.requireApproval).toBe(false);

    // the boundary change is audited with the measured error rate that earned it
    const changes = await listBoundaryChanges(owner.workspaceId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actionType: "chat.post_message",
      direction: "RELAX",
      errorRate: 0,
      windowSize: 100,
      policyRuleId: rule!.id,
    });

    // the Founder Console surfaces the now-owned class with the earning error rate
    const console = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/founder-console`,
        cookies: { rid: owner.cookie },
      })
    ).json();
    expect(console.autonomyBoundaries.owned).toEqual([
      expect.objectContaining({ actionType: "chat.post_message", errorRate: 0, windowSize: 100 }),
    ]);
    expect(console.autonomyBoundaries.history[0]).toMatchObject({
      actionType: "chat.post_message",
      direction: "RELAX",
    });
  });

  it("a relaxed class whose error rate climbs → RE-TIGHTEN: the rule is revoked and audited", async () => {
    const owner = await newOwner();
    // pre-existing earned relaxed boundary
    const rule = await upsertPolicy({
      workspaceId: owner.workspaceId,
      actionType: "chat.post_message",
      requireApproval: false,
      maxAutoAmount: null,
      createdByMemberId: null,
    });
    await recordBoundaryChange({
      workspaceId: owner.workspaceId,
      actionType: "chat.post_message",
      direction: "RELAX",
      errorRate: 0,
      windowSize: 100,
      policyRuleId: rule.id,
      reason: "earned earlier",
    });
    // a window that regressed to a 20% correction rate (> the 15% re-tighten rail)
    await seedEvidence(owner.workspaceId, "chat.post_message", [
      ...Array<Outcome>(20).fill("edited"),
      ...approvals(80),
    ]);

    const applied = await pricer().tick(owner.workspaceId);
    expect(applied).toHaveLength(1);
    expect(applied[0].decision.recommendation).toBe("RETIGHTEN");

    // the rule is gone — the class is gated for a human again
    const stillThere = (await listPolicies(owner.workspaceId)).find(
      (p) => p.actionType === "chat.post_message",
    );
    expect(stillThere).toBeUndefined();

    // and the re-tighten is audited
    const changes = await listBoundaryChanges(owner.workspaceId);
    expect(changes[0]).toMatchObject({ direction: "RETIGHTEN", actionType: "chat.post_message" });

    // the console no longer lists it as owned
    const owned = await ownedBoundaries(owner.workspaceId);
    expect(owned).toEqual([]);
  });

  it("an invariant class is NEVER auto-relaxed, even with a perfect window", async () => {
    const owner = await newOwner();
    await seedEvidence(owner.workspaceId, "billing.payout", approvals(1000));

    const applied = await pricer().tick(owner.workspaceId);
    expect(applied).toEqual([]);

    // no auto-approve rule was created for the outbound-money class
    const rule = (await listPolicies(owner.workspaceId)).find((p) => p.actionType === "billing.payout");
    expect(rule).toBeUndefined();
    // and no boundary change was audited
    expect(await listBoundaryChanges(owner.workspaceId)).toEqual([]);
  });

  it("records gate_evidence on a real #13 decision — an EDITED approval runs the edited draft and is measured", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Poster");
    const channelId = await channelWithAgent(owner, agent.memberId);

    // gate chat.post_message so the agent's post pauses for a human
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/approval-policies`,
      cookies: { rid: owner.cookie },
      payload: { actionType: "chat.post_message", requireApproval: true },
    });
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: bearer(agent.token),
      payload: { actionType: "chat.post_message", payload: { channelId, body: "ship it rn" } },
    });
    const requestId = submit.json().request.id;

    // the human approves WITH an edit to the drafted body
    const approve = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      cookies: { rid: owner.cookie },
      payload: { reason: "fixed the wording", edit: { field: "body", value: "ship it right now" } },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("executed");

    // the EDITED draft is what actually posted
    const messages = (
      await app.inject({ method: "GET", url: `/channels/${channelId}/messages`, cookies: { rid: owner.cookie } })
    ).json();
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("ship it right now");

    // and the decision was recorded as `edited` evidence with a positive edit distance + ttd
    const window = await readEvidenceWindow(owner.workspaceId, "chat.post_message", 10);
    expect(window).toContain("edited");
  });

  it("records a `rejected` decision as evidence (an error toward the class's rate)", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Poster");
    const channelId = await channelWithAgent(owner, agent.memberId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/approval-policies`,
      cookies: { rid: owner.cookie },
      payload: { actionType: "chat.post_message", requireApproval: true },
    });
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: bearer(agent.token),
      payload: { actionType: "chat.post_message", payload: { channelId, body: "nope" } },
    });
    const requestId = submit.json().request.id;

    const reject = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/reject`,
      cookies: { rid: owner.cookie },
      payload: { reason: "off-brand" },
    });
    expect(reject.statusCode).toBe(200);

    const window = await readEvidenceWindow(owner.workspaceId, "chat.post_message", 10);
    expect(window).toEqual(["rejected"]);
  });
});
