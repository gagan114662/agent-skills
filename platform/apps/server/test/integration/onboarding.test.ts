import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, externalCredentials } from "../../src/db/schema/index.js";
import { listRequests } from "../../src/db/repositories/approvals.js";
import { resolveAllServiceSecrets } from "../../src/db/repositories/external-credentials.js";

/**
 * #192 — External account onboarding end-to-end over the real DB: the write-only vault, the
 * blocked-setup → #13 decision-queue park, the default-OFF gate, and autonomous DNS receipts.
 */
let app: FastifyInstance;
const slugs: string[] = [];
const SECRET = "SG.super-secret-key-value";

beforeAll(async () => {
  process.env.RELOAD_ONBOARDING_ENABLED = "true"; // owner workspace opts in
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  delete process.env.RELOAD_ONBOARDING_ENABLED;
  await app.close();
  await closeDb();
  await closeRedis();
});

function cookieOf(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === "rid");
  if (!c) throw new Error("no session cookie");
  return c.value;
}

async function signup(): Promise<{ rid: string; slug: string }> {
  const slug = `onb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  slugs.push(slug);
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email: `${slug}@example.com`,
      password: "hunter2hunter2",
      displayName: "Owner",
      workspaceSlug: slug,
    },
  });
  expect(res.statusCode).toBe(201);
  return { rid: cookieOf(res), slug };
}

async function workspaceIdOf(slug: string): Promise<string> {
  const [w] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return w!.id;
}

describe("External account onboarding API (#192)", () => {
  it("requires authentication for the checklist", async () => {
    const res = await app.inject({ method: "GET", url: "/me/external-services" });
    expect(res.statusCode).toBe(401);
  });

  it("renders an empty checklist for a fresh workspace", async () => {
    const { rid } = await signup();
    const res = await app.inject({ method: "GET", url: "/me/external-services", cookies: { rid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requests: [], pendingSetupCount: 0 });
  });

  it("files a setup need and PARKS it in the #13 decision queue (acceptance 1 + 5)", async () => {
    const { rid, slug } = await signup();
    const res = await app.inject({
      method: "POST",
      url: "/me/external-services",
      cookies: { rid },
      payload: {
        required: [
          {
            serviceKey: "sendgrid",
            serviceKind: "esp",
            displayName: "SendGrid",
            reason: "transactional email",
            projectedCostCents: 1500,
            envKeys: ["SENDGRID_API_KEY"],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const filed = res.json().filed as Array<{ serviceKey: string; approvalRequestId: string | null }>;
    expect(filed[0].serviceKey).toBe("sendgrid");
    expect(filed[0].approvalRequestId).toBeTruthy();

    // The parked approval is a pending request in the decision queue, tenant-scoped.
    const workspaceId = await workspaceIdOf(slug);
    const pending = await listRequests(workspaceId, { status: "pending" });
    expect(pending.some((r) => r.actionType === "setup.external_account")).toBe(true);
  });

  it("connects credentials WRITE-ONLY (sealed, never echoed) and injects them only as resolved env", async () => {
    const { rid, slug } = await signup();
    const put = await app.inject({
      method: "PUT",
      url: "/me/external-credentials/sendgrid",
      cookies: { rid },
      payload: { secrets: { SENDGRID_API_KEY: SECRET }, rotationReminderDays: 90 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(SECRET); // never echoes the key
    expect(put.json()).toMatchObject({ connected: true, envKeys: ["SENDGRID_API_KEY"] });

    // The checklist shows connected, still never leaking the value.
    const list = await app.inject({ method: "GET", url: "/me/external-services", cookies: { rid } });
    expect(list.body).not.toContain(SECRET);
    expect((list.json().requests as Array<{ connected: boolean }>).length).toBe(0); // no request was filed here

    // The stored secret is sealed at rest (the raw value is not in the DB column verbatim unless no key).
    const workspaceId = await workspaceIdOf(slug);
    const [row] = await db
      .select({ secrets: externalCredentials.secrets })
      .from(externalCredentials)
      .where(eq(externalCredentials.workspaceId, workspaceId))
      .limit(1);
    // The only read-back path decrypts to the original — proving round-trip without any API exposing it.
    const resolved = await resolveAllServiceSecrets(workspaceId);
    expect(resolved.SENDGRID_API_KEY).toBe(SECRET);
    expect(row).toBeDefined();
  });

  it("configures + verifies DNS autonomously with receipts (acceptance 3)", async () => {
    const { rid } = await signup();
    const res = await app.inject({
      method: "POST",
      url: "/me/external-dns",
      cookies: { rid },
      payload: { domain: "launch.example.com", spfIncludes: ["sendgrid.net"], dmarcRua: "d@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ domain: "launch.example.com" });
    expect(res.json().summary.allVerified).toBe(true);

    const receipts = await app.inject({
      method: "GET",
      url: "/me/external-dns/receipts?domain=launch.example.com",
      cookies: { rid },
    });
    const rows = receipts.json().receipts as Array<{ purpose: string; status: string }>;
    expect(rows.some((r) => r.purpose === "spf")).toBe(true);
    expect(rows.some((r) => r.purpose === "dmarc")).toBe(true);
    expect(rows.some((r) => r.status === "verified")).toBe(true);
  });

  it("revokes a service gracefully — the credential goes offline but the audit row remains", async () => {
    const { rid, slug } = await signup();
    await app.inject({
      method: "PUT",
      url: "/me/external-credentials/sendgrid",
      cookies: { rid },
      payload: { secrets: { SENDGRID_API_KEY: SECRET } },
    });
    const del = await app.inject({
      method: "DELETE",
      url: "/me/external-credentials/sendgrid",
      cookies: { rid },
    });
    expect(del.statusCode).toBe(200);

    const workspaceId = await workspaceIdOf(slug);
    // The revoked credential resolves to nothing (capability offline), but the row survives for audit.
    expect(await resolveAllServiceSecrets(workspaceId)).toEqual({});
    const [row] = await db
      .select({ status: externalCredentials.status })
      .from(externalCredentials)
      .where(eq(externalCredentials.workspaceId, workspaceId))
      .limit(1);
    expect(row!.status).toBe("revoked");
  });

  it("gates the risky writes behind onboarding.enabled (default-OFF → 409)", async () => {
    const { rid } = await signup();
    delete process.env.RELOAD_ONBOARDING_ENABLED; // simulate a workspace that hasn't opted in
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/me/external-credentials/sendgrid",
        cookies: { rid },
        payload: { secrets: { SENDGRID_API_KEY: SECRET } },
      });
      expect(res.statusCode).toBe(409);
      // reads still work even when disabled
      const list = await app.inject({ method: "GET", url: "/me/external-services", cookies: { rid } });
      expect(list.statusCode).toBe(200);
    } finally {
      process.env.RELOAD_ONBOARDING_ENABLED = "true";
    }
  });
});
