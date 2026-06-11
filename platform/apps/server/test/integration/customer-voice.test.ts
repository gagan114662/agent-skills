import { describe, it, expect, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, voiceInsights, supportTickets } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { signWebhookPayload } from "../../src/billing/webhook.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { createDefaultCustomerVoiceService } from "../../src/voice/default.js";
import { listRequests } from "../../src/db/repositories/approvals.js";

/**
 * Customer Voice Loop (#114) integration — real Postgres + Redis. The inbound webhook is signed; the
 * reply gate creates a PENDING #13 request and never sends. Tenant-isolated by a unique workspace slug per
 * test (shared PG across Conductor workspaces); cleaned up in afterAll.
 */
const WHSEC = "whsec_voice_secret_abc";

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function startApp(): Promise<FastifyInstance> {
  const secrets = new StaticSecretsResolver({ VOICE_WEBHOOK_SECRET: WHSEC });
  const voice = createDefaultCustomerVoiceService(secrets);
  const app = buildApp({ voice });
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
  const slug = `voice-${newId()}`;
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
  return { "content-type": "application/json", "voice-signature": signWebhookPayload(raw, WHSEC, Math.floor(Date.now() / 1000)) };
}

describe("Customer Voice Loop (#114 — real Postgres + Redis, inbound-only, no autonomous sends)", () => {
  it("signed webhook → support ticket → classified user_voice insight (the evidence row)", async () => {
    const app = await startApp();
    const w = await seed(app);

    const raw = JSON.stringify({
      kind: "support",
      channel: "email",
      sourceRef: `msg-${newId()}`,
      contact: "user@example.com",
      subject: "App is broken",
      body: "The app keeps crashing with an error, this is totally broken and I'm frustrated",
    });
    const res = await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(raw), payload: raw });
    expect(res.statusCode).toBe(201);
    const { ticketId, insightId, deduped } = res.json();
    expect(deduped).toBe(false);

    // A replay of the same (channel, sourceRef) is idempotent — no second ticket.
    const replay = await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(raw), payload: raw });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().deduped).toBe(true);

    // The ticket was classified (negative, bug) and lands needing a human.
    const ticket = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/voice/tickets/${ticketId}`, cookies: { rid: w.cookie } })).json();
    expect(ticket.sentiment).toBe("negative");
    expect(ticket.category).toBe("bug");
    expect(ticket.status).toBe("triaged");
    expect(ticket.draftReply).toBeNull(); // no triage agent wired → needs a human

    // The evidence row exists in the DB: kind = user_voice, source_kind = support_ticket, linked to the ticket.
    const insightRows = await db
      .select()
      .from(voiceInsights)
      .where(and(eq(voiceInsights.workspaceId, w.workspaceId), eq(voiceInsights.id, insightId)));
    expect(insightRows).toHaveLength(1);
    expect(insightRows[0].kind).toBe("user_voice");
    expect(insightRows[0].sourceKind).toBe("support_ticket");
    expect(insightRows[0].ticketId).toBe(ticketId);
    expect(insightRows[0].sentiment).toBe("negative");
  });

  it("reply-send gate is sensitive-by-default: submitReply enqueues a PENDING external.send and never sends", async () => {
    const app = await startApp();
    const w = await seed(app);
    const raw = JSON.stringify({ kind: "support", channel: "email", sourceRef: `m-${newId()}`, contact: "c@e.com", body: "please help" });
    const tid = (await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(raw), payload: raw })).json().ticketId;

    const reply = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/voice/tickets/${tid}/reply`,
      cookies: { rid: w.cookie },
      payload: { body: "Sorry about that — here is how to fix it." },
    });
    expect(reply.statusCode).toBe(202);
    const { approvalRequestId, status } = reply.json();
    expect(status).toBe("awaiting_approval");

    // The #13 request exists and is PENDING (a human approves before anything is sent) — external.send.
    const pending = await listRequests(w.workspaceId, { status: "pending" });
    const req = pending.find((r) => r.id === approvalRequestId);
    expect(req).toBeDefined();
    expect(req!.actionType).toBe("external.send");
    expect(req!.status).toBe("pending");

    // The ticket reflects the awaiting-approval state + the linked request.
    const ticket = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/voice/tickets/${tid}`, cookies: { rid: w.cookie } })).json();
    expect(ticket.status).toBe("awaiting_approval");
    expect(ticket.replyApprovalRequestId).toBe(approvalRequestId);
  });

  it("NPS + cancellation feedback ingests as insights; the digest + metrics roll them up", async () => {
    const app = await startApp();
    const w = await seed(app);
    for (const [kind, body, npsScore] of [
      ["nps", "amazing", 10],
      ["nps", "not great", 3],
      ["cancellation", "too expensive, switching", null],
    ] as const) {
      const raw = JSON.stringify({ kind, sourceRef: `${kind}-${newId()}`, text: body, npsScore });
      const r = await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(raw), payload: raw });
      expect(r.statusCode).toBe(201);
    }
    const metrics = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/voice/metrics`, cookies: { rid: w.cookie } })).json();
    expect(metrics.total).toBe(3);
    expect(metrics.nps.responses).toBe(2);

    const digest = (await app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}/voice/digest`, cookies: { rid: w.cookie } })).json();
    expect(digest.totalSignals).toBe(3);
    expect(typeof digest.headline).toBe("string");
  });

  it("feeds the #96 scorecard: post-launch voice replaces the problemSeverity dimension", async () => {
    const app = await startApp();
    const w = await seed(app);
    const ideaId = (await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/ventures`,
      cookies: { rid: w.cookie },
      payload: { problem: "p", targetUser: "u", insight: "i", wedge: "w", marketPath: "m" },
    })).json().id;

    // Ingest customer-voice tied to the idea, then score → the reasoning records the voice overlay.
    const raw = JSON.stringify({ kind: "nps", sourceRef: `n-${newId()}`, text: "love it", npsScore: 10, ventureIdeaId: ideaId });
    expect((await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(raw), payload: raw })).statusCode).toBe(201);

    const scored = await app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}/ventures/${ideaId}/score`, cookies: { rid: w.cookie } });
    expect(scored.statusCode).toBe(200);
    expect(scored.json().reasoning).toContain("customer-voice signal");
  });

  it("webhook validates input: malformed ventureIdeaId and bad npsScore are 400 (not a 500 from the DB)", async () => {
    const app = await startApp();
    const w = await seed(app);

    const badIdea = JSON.stringify({ kind: "support", channel: "email", sourceRef: `m-${newId()}`, body: "hi", ventureIdeaId: "not-a-uuid" });
    const r1 = await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(badIdea), payload: badIdea });
    expect(r1.statusCode).toBe(400);

    const badNps = JSON.stringify({ kind: "nps", sourceRef: `n-${newId()}`, text: "x", npsScore: 42 });
    const r2 = await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(badNps), payload: badNps });
    expect(r2.statusCode).toBe(400);

    const missingNps = JSON.stringify({ kind: "nps", sourceRef: `n2-${newId()}`, text: "x" });
    const r3 = await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(missingNps), payload: missingNps });
    expect(r3.statusCode).toBe(400);
  });

  it("webhook is disabled (503) when no voice secret is configured", async () => {
    const app = buildApp({ voice: createDefaultCustomerVoiceService(new StaticSecretsResolver({})) });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const w = await seed(app);
    const raw = JSON.stringify({ kind: "support", channel: "email", sourceRef: "x", body: "hi" });
    const res = await app.inject({ method: "POST", url: `/voice/webhook/${w.workspaceId}`, headers: signed(raw), payload: raw });
    expect(res.statusCode).toBe(503);
  });

  it("tenant isolation: a sibling workspace cannot read another's ticket (404, no leak)", async () => {
    const app = await startApp();
    const a = await seed(app);
    const b = await seed(app);
    const raw = JSON.stringify({ kind: "support", channel: "email", sourceRef: `m-${newId()}`, body: "secret" });
    const tid = (await app.inject({ method: "POST", url: `/voice/webhook/${a.workspaceId}`, headers: signed(raw), payload: raw })).json().ticketId;

    // B tries to read A's ticket through B's own workspace → 404.
    const crossB = await app.inject({ method: "GET", url: `/workspaces/${b.workspaceId}/voice/tickets/${tid}`, cookies: { rid: b.cookie } });
    expect(crossB.statusCode).toBe(404);

    // B tries to read A's ticket through A's workspace path with B's cookie → 403 (wrong workspace).
    const wrongWs = await app.inject({ method: "GET", url: `/workspaces/${a.workspaceId}/voice/tickets/${tid}`, cookies: { rid: b.cookie } });
    expect(wrongWs.statusCode).toBe(403);

    // The ticket really exists for A.
    const owned = await db.select().from(supportTickets).where(eq(supportTickets.id, tid));
    expect(owned).toHaveLength(1);
    expect(owned[0].workspaceId).toBe(a.workspaceId);
  });
});
