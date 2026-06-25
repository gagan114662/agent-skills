import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { dbWorkspacePlanStore } from "../../src/db/repositories/plans.js";

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

async function signup(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `caps-${newId()}`;
  slugs.push(slug);
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = res.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json() as {
    workspaceId: string;
  };
  return { cookie, workspaceId: me.workspaceId };
}

async function activatePaidPlan(workspaceId: string): Promise<void> {
  const now = new Date();
  await dbWorkspacePlanStore.activate({
    workspaceId,
    planKey: "pro",
    caps: { agentSeats: 10, monthlySessionBudgetCents: 100_000, fleetSize: 5 },
    providerEventId: `evt_caps_${newId()}`,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    nextBillingAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  });
}

describe("#871 workspace capability self-service", () => {
  it("lets a paid workspace enable runtime capabilities and unblocks onboarding writes", async () => {
    const owner = await signup();

    const blocked = await app.inject({
      method: "PUT",
      url: "/me/external-credentials/sendgrid",
      cookies: { rid: owner.cookie },
      payload: { secrets: { SENDGRID_API_KEY: "SG.test" } },
    });
    expect(blocked.statusCode).toBe(409);

    const unpaid = await app.inject({
      method: "PATCH",
      url: `/workspaces/${owner.workspaceId}/capabilities`,
      cookies: { rid: owner.cookie },
      payload: { onboarding: true },
    });
    expect(unpaid.statusCode).toBe(402);

    await activatePaidPlan(owner.workspaceId);

    const enabled = await app.inject({
      method: "PATCH",
      url: `/workspaces/${owner.workspaceId}/capabilities`,
      cookies: { rid: owner.cookie },
      payload: { marketing: true, onboarding: true, realworld: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      capabilities: { marketing: true, onboarding: true, realworld: true },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/capabilities`,
      cookies: { rid: owner.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      paidPlanActive: true,
      capabilities: { marketing: true, onboarding: true, realworld: true },
    });

    const connected = await app.inject({
      method: "PUT",
      url: "/me/external-credentials/sendgrid",
      cookies: { rid: owner.cookie },
      payload: { secrets: { SENDGRID_API_KEY: "SG.test" } },
    });
    expect(connected.statusCode).toBe(200);
    expect(JSON.stringify(connected.json())).not.toContain("SG.test");
  });
});
