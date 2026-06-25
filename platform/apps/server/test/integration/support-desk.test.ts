import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { signWebhookPayload } from "../../src/billing/webhook.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { createDefaultSupportDeskService } from "../../src/support/default.js";
import { approveAndLock, listRequests } from "../../src/db/repositories/approvals.js";
import { executeApprovedRequest } from "../../src/approvals/execute.js";
import { buildAcquisitionRegistry } from "../../src/acquisition/default.js";

/**
 * Support Desk (#190) integration — real Postgres + Redis. Proves the SAFE DEFAULT (premortem #200): with
 * no autonomy opted in, every reply is a #13 human gate and nothing is sent autonomously; refunds always
 * land in the MONEY queue as a gated `billing.refund`; resolution counts come from external receipts;
 * tenant isolation holds. Tenant-isolated by a unique workspace slug per test (shared PG); cleaned in afterAll.
 */
const WHSEC = "whsec_support_secret_xyz";

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function startApp(): Promise<FastifyInstance> {
  const secrets = new StaticSecretsResolver({ SUPPORT_WEBHOOK_SECRET: WHSEC });
  const supportDesk = createDefaultSupportDeskService(secrets);
  const app = buildApp({ supportDesk });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  void (app.server.address() as AddressInfo);
  return app;
}

interface World {
  cookie: string;
  workspaceId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `support-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId };
}

function signed(raw: string) {
  return { "content-type": "application/json", "support-signature": signWebhookPayload(raw, WHSEC, Math.floor(Date.now() / 1000)) };
}

async function ingestWidget(app: FastifyInstance, wid: string, body: Record<string, unknown>) {
  const raw = JSON.stringify({ channel: "widget", sourceRef: `w-${newId()}`, ...body });
  return app.inject({ method: "POST", url: `/support/widget/${wid}`, headers: signed(raw), payload: raw });
}

describe("Support Desk (#190 — real Postgres + Redis, default-safe: no autonomous sends)", () => {
  it("widget webhook requires a configured secret + a valid signature", async () => {
    const app = await startApp();
    const w = await seed(app);
    // Wrong signature → 400.
    const raw = JSON.stringify({ channel: "widget", sourceRef: "x", body: "hi" });
    const bad = await app.inject({
      method: "POST",
      url: `/support/widget/${w.workspaceId}`,
      headers: { "content-type": "application/json", "support-signature": "t=1,v1=deadbeef" },
      payload: raw,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("a question with no KB confidently answering it escalates to a human (the desk never bluffs)", async () => {
    const app = await startApp();
    const w = await seed(app);
    const res = await ingestWidget(app, w.workspaceId, { body: "How do I configure single sign-on?", contact: "a@e.com" });
    expect(res.statusCode).toBe(202);
    const out = res.json();
    expect(out.route).toBe("escalate");
    expect(out.autoSent).toBe(false);
    expect(out.escalationReasons).toContain("unknown");
    // No outbound #13 request was created for an escalation.
    expect(await listRequests(w.workspaceId)).toHaveLength(0);
  });

  it("with a KB answer but autonomy OFF (default), a reply is a PENDING #13 external.send — never sent", async () => {
    const app = await startApp();
    const w = await seed(app);
    // Curate a KB entry the question will match.
    await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/support/kb`,
      cookies: { rid: w.cookie },
      payload: { title: "Reset your password", body: "Open settings and click reset password to reset your password.", category: "support" },
    });
    const res = await ingestWidget(app, w.workspaceId, { body: "how do I reset my password?", contact: "b@e.com" });
    expect(res.statusCode).toBe(202);
    const out = res.json();
    // Default caps: autoSend OFF → the route falls back to approval (and even auto_send would not execute
    // without an AutoApprover). Either way: no autonomous send.
    expect(out.autoSent).toBe(false);
    expect(out.receipts.length).toBeGreaterThan(0); // the answer cited the KB entry

    const pending = await listRequests(w.workspaceId, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].actionType).toBe("external.send");
    // Nothing executed.
    expect(await listRequests(w.workspaceId, { status: "executed" })).toHaveLength(0);
  });

  it("approving a support reply without a delivery dispatcher fails loudly instead of recording a fake send (#911)", async () => {
    const app = await startApp();
    const w = await seed(app);
    await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/support/kb`,
      cookies: { rid: w.cookie },
      payload: { title: "Reset your password", body: "Open settings and click reset password to reset your password.", category: "support" },
    });
    const res = await ingestWidget(app, w.workspaceId, { body: "how do I reset my password?", contact: "b@e.com" });
    expect(res.statusCode).toBe(202);

    const [pending] = await listRequests(w.workspaceId, { status: "pending" });
    expect(pending?.actionType).toBe("external.send");
    const approved = await approveAndLock(
      pending!.id,
      w.workspaceId,
      pending!.requesterMemberId,
      "integration-test",
    );
    expect(approved.outcome).toBe("approved");
    if (approved.outcome !== "approved") throw new Error("approval did not lock");

    const execution = await executeApprovedRequest(buildAcquisitionRegistry(), approved.request, app.log);

    expect(execution.outcome).toBe("failed");
    expect(execution.request?.status).toBe("failed");
    expect(execution.request?.error).toMatch(/support reply delivery path not configured/);
    expect(await listRequests(w.workspaceId, { status: "executed" })).toHaveLength(0);
  });

  it("a refund intent ALWAYS lands in the MONEY queue as a gated billing.refund — never auto-executed", async () => {
    const app = await startApp();
    const w = await seed(app);
    const res = await ingestWidget(app, w.workspaceId, { body: "I want a refund, this didn't work", contact: "c@e.com" });
    expect(res.statusCode).toBe(202);
    expect(res.json().route).toBe("money_queue");

    const pending = await listRequests(w.workspaceId, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].actionType).toBe("billing.refund");
    expect(await listRequests(w.workspaceId, { status: "executed" })).toHaveLength(0);
  });

  it("a signed receipt webhook makes resolution VERIFIED; status-only stays UNVERIFIED (premortem §2)", async () => {
    const app = await startApp();
    const w = await seed(app);
    const ingest = await ingestWidget(app, w.workspaceId, { body: "thanks, all good now", contact: "d@e.com" });
    const ticketId = ingest.json().ticketId;

    // Before any receipt: metrics show 0 verified.
    let metrics = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/support/metrics`, cookies: { rid: w.cookie } })).json();
    expect(metrics.resolvedVerified).toBe(0);
    expect(metrics.unverifiedLabeled).toBe(true);

    // A signed external `resolved` receipt arrives.
    const raw = JSON.stringify({ kind: "resolved", ticketId, providerRef: `evt-${newId()}` });
    const rec = await app.inject({ method: "POST", url: `/support/receipts/${w.workspaceId}`, headers: signed(raw), payload: raw });
    expect(rec.statusCode).toBe(201);
    // Replay is idempotent.
    expect((await app.inject({ method: "POST", url: `/support/receipts/${w.workspaceId}`, headers: signed(raw), payload: raw })).statusCode).toBe(200);

    metrics = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/support/metrics`, cookies: { rid: w.cookie } })).json();
    expect(metrics.resolvedVerified).toBe(1);
  });

  it("an old unanswered ticket surfaces as an SLA breach (read-only)", async () => {
    const app = await startApp();
    const w = await seed(app);
    const ingest = await ingestWidget(app, w.workspaceId, { body: "still waiting on help", contact: "e@e.com" });
    const ticketId = ingest.json().ticketId;
    // Backdate the ticket so it is past the default 240-min SLA.
    const { supportTickets } = await import("../../src/db/schema/index.js");
    await db.update(supportTickets).set({ createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6) }).where(eq(supportTickets.id, ticketId));

    const breaches = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/support/sla`, cookies: { rid: w.cookie } })).json();
    expect(Array.isArray(breaches)).toBe(true);
    expect(breaches.some((b: { ticketId: string }) => b.ticketId === ticketId)).toBe(true);
  });

  it("tenant isolation: a member cannot read another workspace's support desk", async () => {
    const app = await startApp();
    const a = await seed(app);
    const b = await seed(app);
    // a's cookie against b's workspace → 403.
    const res = await app.inject({ method: "GET", url: `/workspaces/${b.workspaceId}/support/sla`, cookies: { rid: a.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("mines recurring real prospect questions into objection FAQ KB entries", async () => {
    const app = await startApp();
    const w = await seed(app);
    const first = await ingestWidget(app, w.workspaceId, {
      body: "Is SOC2 required before we can use this with customer data?",
      contact: "buyer-a@example.com",
    });
    expect(first.statusCode).toBe(202);
    const second = await ingestWidget(app, w.workspaceId, {
      body: "Do you have SOC2 before we put customer data in it?",
      contact: "buyer-b@example.com",
    });
    expect(second.statusCode).toBe(202);

    const refresh = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/support/objections/refresh`,
      cookies: { rid: w.cookie },
      payload: { minCount: 2 },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().drafts[0]).toMatchObject({ signature: "soc2", count: 2 });

    const kb = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/support/kb?category=objection`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(kb).toHaveLength(1);
    expect(kb[0].title).toContain("SOC2");
    expect(kb[0].body).toContain("Short answer");
    expect(kb[0].provenance).toContain("objection_miner:soc2");
  });

  it("KB curation is deduped on slug (re-curating updates in place)", async () => {
    const app = await startApp();
    const w = await seed(app);
    const post = () =>
      app.inject({
        method: "POST",
        url: `/workspaces/${w.workspaceId}/support/kb`,
        cookies: { rid: w.cookie },
        payload: { title: "Shipping policy", body: "We ship in 3 days.", category: "support" },
      });
    const first = await post();
    expect(first.statusCode).toBe(201);
    const second = await post();
    expect(second.statusCode).toBe(200);
    expect(second.json().deduped).toBe(true);
    const kb = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/support/kb`, cookies: { rid: w.cookie } })).json();
    expect(kb.filter((e: { slug: string }) => e.slug === "shipping-policy")).toHaveLength(1);
  });
});
