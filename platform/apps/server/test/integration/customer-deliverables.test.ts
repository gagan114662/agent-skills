import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb, db } from "../../src/db/index.js";
import { newId } from "../../src/db/id.js";
import { dbDeliveryReceiptStore, recordDeliverablePerformance } from "../../src/db/repositories/delivery.js";
import { createChannel } from "../../src/db/repositories/channels.js";
import { createAgentSession, finalizeSession } from "../../src/db/repositories/agent-sessions.js";
import { dbWorkspacePlanStore } from "../../src/db/repositories/plans.js";
import { workspaces } from "../../src/db/schema/index.js";

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

async function newWorkspace(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = "cust-deliv-" + newId();
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email: "u-" + newId() + "@e.com",
      password: "pw",
      displayName: "Owner",
      workspaceSlug: slug,
    },
  });
  expect(signup.statusCode).toBe(201);
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

describe("customer deliverables (#915)", () => {
  it("lets a customer list shipped artifacts with live refs, agent activity, performance, feedback URL, and plan state", async () => {
    const ws = await newWorkspace();
    const channel = await createChannel({
      workspaceId: ws.workspaceId,
      kind: "public",
      name: "content",
    });
    const agent = await app.inject({
      method: "POST",
      url: "/workspaces/" + ws.workspaceId + "/agents",
      cookies: { rid: ws.cookie },
      payload: { name: "Scout" },
    });
    expect(agent.statusCode).toBe(201);
    const session = await createAgentSession({
      workspaceId: ws.workspaceId,
      channelId: channel.id,
      agentMemberId: agent.json().memberId,
      createdByMemberId: ws.memberId,
      runtime: "local",
      command: "ship the article",
      caps: { wallClockMs: 30_000, idleMs: 5_000 },
    });
    await finalizeSession(session.id, {
      status: "completed",
      exitCode: 0,
      result: "Published the comparison page.",
    });
    const receipt = await dbDeliveryReceiptStore.record({
      workspaceId: ws.workspaceId,
      approvalRequestId: newId(),
      sessionId: session.id,
      channel: "publish",
      reversibility: "reversible",
      provider: "github_pages",
      live: true,
      computeSeconds: 42,
      estimatedCostCents: 17,
      externalRef: "https://ipop.ai/customers/acme",
      status: "shipped",
      detail: { title: "Acme launch page" },
    });
    await recordDeliverablePerformance({
      workspaceId: ws.workspaceId,
      deliveryReceiptId: receipt.id,
      source: "manual",
      views: 100,
      engagements: 20,
      conversions: 3,
      externalMetricRef: "manual:week-1",
      measuredAt: new Date("2026-06-25T00:00:00.000Z"),
    });
    await dbWorkspacePlanStore.activate({
      workspaceId: ws.workspaceId,
      planKey: "pro",
      caps: { agentSeats: 10, monthlySessionBudgetCents: 100_000, fleetSize: 3 },
      providerEventId: "evt_paid",
      expiresAt: new Date("2026-07-25T00:00:00.000Z"),
      nextBillingAt: new Date("2026-07-25T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: "/me/deliverables",
      cookies: { rid: ws.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      trial: {
        planKey: "pro",
        status: "active",
        converted: true,
        currentPeriodEndsAt: "2026-07-25T00:00:00.000Z",
      },
      deliverables: [
        {
          id: receipt.id,
          sessionId: session.id,
          channel: "publish",
          provider: "github_pages",
          live: true,
          externalRef: "https://ipop.ai/customers/acme",
          feedbackUrl: "/me/deliverables/" + receipt.id + "/feedback",
          agentActivity: {
            sessionId: session.id,
            agentMemberId: agent.json().memberId,
            channelId: channel.id,
            status: "completed",
            agentStatus: "done",
          },
          performance: {
            views: 100,
            engagements: 20,
            conversions: 3,
            engagementRate: 0.2,
            conversionRate: 0.03,
            latestMeasuredAt: "2026-06-25T00:00:00.000Z",
          },
        },
      ],
    });
  });

  it("keeps deliverable feedback workspace-scoped", async () => {
    const owner = await newWorkspace();
    const other = await newWorkspace();
    const receipt = await dbDeliveryReceiptStore.record({
      workspaceId: owner.workspaceId,
      approvalRequestId: newId(),
      sessionId: null,
      channel: "email",
      reversibility: "irreversible",
      provider: "postmark",
      live: true,
      externalRef: "msg_123",
      status: "shipped",
      detail: {},
    });

    const denied = await app.inject({
      method: "POST",
      url: "/me/deliverables/" + receipt.id + "/feedback",
      cookies: { rid: other.cookie },
      payload: { rating: 1, category: "unclear", comment: "Not ours" },
    });
    expect(denied.statusCode).toBe(404);

    const accepted = await app.inject({
      method: "POST",
      url: "/me/deliverables/" + receipt.id + "/feedback",
      cookies: { rid: owner.cookie },
      payload: { rating: 5, category: "helpful", comment: "This helped." },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().feedback).toMatchObject({
      workspaceId: owner.workspaceId,
      deliveryReceiptId: receipt.id,
      rating: 5,
      category: "helpful",
      comment: "This helped.",
    });
  });
});
