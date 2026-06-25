import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { renderMetrics, resetMetrics } from "../../src/observability/metrics.js";

/**
 * Hermetic unit test of the public inbound-lead capture route (GAP 1 of the leads centre, ADR-0400). The
 * repository (Postgres) is mocked and the discovery service is an in-memory fake — so this proves the route
 * logic (202 receipt, validation/sanitization, workspace resolution, best-effort discovery feed that never
 * fails capture) with no Postgres/Redis. End-to-end against real Postgres is out of scope (no DB here).
 */

const recordLead = vi.fn(async () => ({ id: "lead-1" }));
const findRecentLeadDuplicate = vi.fn(async () => null);
const verifyLeadByTokenHash = vi.fn(async () => null);
const listLeads = vi.fn(async () => []);
const getLead = vi.fn(async () => null);
const updateLead = vi.fn(async () => null);
const markSlaNotified = vi.fn(async () => true);
const getWorkspaceOwnerMemberId = vi.fn(async () => "33333333-2222-3333-4444-555555555555");
const notify = vi.fn(async () => ({ id: "notif-1" }));
vi.mock("../../src/db/repositories/inbound-leads.js", () => ({
  recordLead,
  findRecentLeadDuplicate,
  verifyLeadByTokenHash,
  listLeads,
  getLead,
  updateLead,
  markSlaNotified,
}));
vi.mock("../../src/db/repositories/members.js", () => ({ getWorkspaceOwnerMemberId }));
vi.mock("../../src/notifications/service.js", () => ({ notify }));
vi.mock("../../src/auth/guard.js", () => ({
  assertWorkspace: vi.fn(
    (
      identity: { workspaceId: string },
      workspaceId: string,
      reply: { code: (status: number) => { send: (body: unknown) => void } },
    ) => {
      if (identity.workspaceId === workspaceId) return true;
      reply.code(403).send({ error: "wrong workspace" });
      return false;
    },
  ),
  requireIdentity: vi.fn(async () => ({
    workspaceId: "11111111-2222-3333-4444-555555555555",
    memberId: "22222222-2222-3333-4444-555555555555",
  })),
}));

const { inboundLeadsRoutes } = await import("../../src/routes/inbound-leads.js");

const OWNER_WID = "11111111-2222-3333-4444-555555555555";

interface FakeDiscovery {
  defineSignal: ReturnType<typeof vi.fn>;
  ingestSignal: ReturnType<typeof vi.fn>;
}

async function buildRoute(
  ownerWorkspaceId: string | undefined,
  discovery: FakeDiscovery,
  warmLeadFollowup?: Parameters<typeof inboundLeadsRoutes>[1]["warmLeadFollowup"],
  confirmation?: Parameters<typeof inboundLeadsRoutes>[1]["confirmation"],
): Promise<{ app: FastifyInstance; warn: ReturnType<typeof vi.spyOn> }> {
  const app = Fastify();
  const warn = vi.spyOn(app.log, "warn");
  await app.register(inboundLeadsRoutes, {
    discovery: discovery as unknown as Parameters<typeof inboundLeadsRoutes>[1]["discovery"],
    ownerWorkspaceId,
    warmLeadFollowup,
    confirmation,
  });
  await app.ready();
  return { app, warn };
}

function fakeDiscovery(impl?: () => Promise<unknown>): FakeDiscovery {
  return {
    defineSignal: vi.fn(async () => ({})),
    ingestSignal: vi.fn(impl ?? (async () => ({ signal: {}, pqls: [] }))),
  };
}

function verifiedLead(over: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    workspaceId: OWNER_WID,
    name: "Ada",
    email: "ada@example.com",
    message: "fix our SEO",
    source: "landing_form",
    trackingRef: null,
    verified: true,
    verifiedAtMs: Date.now(),
    status: "new",
    assigneeMemberId: null,
    nextAction: null,
    respondedAtMs: null,
    slaDueAtMs: Date.now() + 86_400_000,
    slaNotifiedAtMs: null,
    slaBreached: false,
    reachContactKey: "email:ada@example.com",
    createdAtMs: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  resetMetrics();
  recordLead.mockClear();
  findRecentLeadDuplicate.mockReset();
  findRecentLeadDuplicate.mockResolvedValue(null);
  verifyLeadByTokenHash.mockReset();
  verifyLeadByTokenHash.mockResolvedValue(null);
  listLeads.mockReset();
  listLeads.mockResolvedValue([]);
  getLead.mockClear();
  updateLead.mockClear();
  markSlaNotified.mockClear();
  getWorkspaceOwnerMemberId.mockClear();
  notify.mockClear();
});

describe("POST /inbound/leads (public capture)", () => {
  it("persists a clean lead as unverified, sends confirmation, then activates it on click", async () => {
    const disc = fakeDiscovery();
    const followup = { handle: vi.fn(async () => undefined) };
    const confirmation = { secret: "test-secret", baseUrl: "https://ipop.ai", send: vi.fn(async () => undefined) };
    const { app } = await buildRoute(OWNER_WID, disc, followup, confirmation);
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { name: "Ada", email: "ada@example.com", message: "fix our SEO" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      received: true,
      nextStep: { label: "Start a free trial now", href: "/start?source=inbound_lead" },
    });
    expect(recordLead).toHaveBeenCalledTimes(1);
    expect(recordLead.mock.calls[0]![0]).toMatchObject({
      workspaceId: OWNER_WID,
      email: "ada@example.com",
      message: "fix our SEO",
      source: "landing_form",
      emailHash: expect.any(String),
      submitterHash: expect.any(String),
      verificationTokenHash: expect.any(String),
      verificationSentAt: expect.any(Date),
    });
    expect(confirmation.send).toHaveBeenCalledWith({
      to: "ada@example.com",
      name: "Ada",
      confirmationUrl: expect.stringContaining("https://ipop.ai/inbound/leads/confirm?"),
    });
    expect(disc.defineSignal).not.toHaveBeenCalled();
    expect(followup.handle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    verifyLeadByTokenHash.mockResolvedValueOnce(verifiedLead());
    const confirmationUrl = confirmation.send.mock.calls[0]![0].confirmationUrl;
    const confirm = await app.inject({
      method: "GET",
      url: confirmationUrl.replace("https://ipop.ai", ""),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ verified: true });
    expect(verifyLeadByTokenHash).toHaveBeenCalledWith(expect.any(String));

    // Best-effort discovery feed starts only after confirmation: a default role_match definition plus an opaque key.
    expect(disc.defineSignal).toHaveBeenCalledWith(
      OWNER_WID,
      expect.objectContaining({
        kind: "role_match",
        label: "inbound_lead_default",
        role: "inbound_lead",
        threshold: 1,
        weight: 100,
      }),
    );
    expect(disc.ingestSignal).toHaveBeenCalledTimes(1);
    const [wid, signal] = disc.ingestSignal.mock.calls[0]!;
    expect(wid).toBe(OWNER_WID);
    expect(signal).toMatchObject({ kind: "role_identified", role: "inbound_lead" });
    expect(signal.prospectKey).not.toContain("@");
    expect(followup.handle).toHaveBeenCalledWith({
      workspaceId: OWNER_WID,
      leadId: "lead-1",
      lead: expect.objectContaining({ email: "ada@example.com", message: "fix our SEO" }),
    });
    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: OWNER_WID,
        recipientMemberId: "33333333-2222-3333-4444-555555555555",
        type: "inbound_lead",
        excerpt: expect.stringContaining("New inbound lead from Ada <ada@example.com>"),
      }),
    );
    await app.close();
  });

  it("rejects an empty email/message with 400 and persists nothing", async () => {
    const { app, warn } = await buildRoute(OWNER_WID, fakeDiscovery());
    const noEmail = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "", message: "hi" },
    });
    expect(noEmail.statusCode).toBe(400);
    const noMsg = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "" },
    });
    expect(noMsg.statusCode).toBe(400);
    expect(recordLead).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid_payload",
        email: "a@b.co",
        source: "unknown",
      }),
      "inbound lead rejected",
    );
    expect(renderMetrics()).toContain('inbound_lead_rejections_total{reason="invalid_payload"} 2');
    await app.close();
  });

  it("503s when no owner workspace is configured and no body wid given", async () => {
    const { app, warn } = await buildRoute(undefined, fakeDiscovery());
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(recordLead).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "not_configured",
        email: "a@b.co",
      }),
      "inbound lead rejected",
    );
    expect(renderMetrics()).toContain('inbound_lead_rejections_total{reason="not_configured"} 1');
    await app.close();
  });

  it("never lets a non-owner workspaceId in the body redirect the lead", async () => {
    const { app, warn } = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: {
        email: "a@b.co",
        message: "hi",
        workspaceId: "99999999-2222-3333-4444-555555555555",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(recordLead).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid_workspace",
        email: "a@b.co",
      }),
      "inbound lead rejected",
    );
    expect(renderMetrics()).toContain(
      'inbound_lead_rejections_total{reason="invalid_workspace"} 1',
    );
    await app.close();
  });

  it("suppresses duplicate same-IP/email submissions within the dedupe window", async () => {
    findRecentLeadDuplicate.mockResolvedValueOnce({ id: "lead-existing" });
    const confirmation = { secret: "test-secret", baseUrl: "https://ipop.ai", send: vi.fn(async () => undefined) };
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery(), undefined, confirmation);
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "ada@example.com", message: "fix our SEO" },
    });
    expect(res.statusCode).toBe(202);
    expect(recordLead).not.toHaveBeenCalled();
    expect(confirmation.send).not.toHaveBeenCalled();
    await app.close();
  });

  it("still returns 202 when the discovery feed throws (capture must not fail)", async () => {
    const disc = fakeDiscovery(async () => {
      throw new Error("discovery down");
    });
    const confirmation = { secret: "test-secret", baseUrl: "https://ipop.ai", send: vi.fn(async () => undefined) };
    const { app } = await buildRoute(OWNER_WID, disc, undefined, confirmation);
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(recordLead).toHaveBeenCalledTimes(1);
    verifyLeadByTokenHash.mockResolvedValueOnce(verifiedLead({ email: "a@b.co", message: "hi" }));
    const confirmationUrl = confirmation.send.mock.calls[0]![0].confirmationUrl;
    const confirm = await app.inject({ method: "GET", url: confirmationUrl.replace("https://ipop.ai", "") });
    expect(confirm.statusCode).toBe(200);
    expect(renderMetrics()).toContain(
      'async_side_effect_failures_total{kind="inbound_lead_discovery_ingest"} 1',
    );
    await app.close();
  });

  it("still returns 202 when warm follow-up throws (capture must not fail)", async () => {
    const followup = {
      handle: vi.fn(async () => {
        throw new Error("reach down");
      }),
    };
    const confirmation = { secret: "test-secret", baseUrl: "https://ipop.ai", send: vi.fn(async () => undefined) };
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery(), followup, confirmation);
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(recordLead).toHaveBeenCalledTimes(1);
    verifyLeadByTokenHash.mockResolvedValueOnce(verifiedLead({ email: "a@b.co", message: "hi" }));
    const confirmationUrl = confirmation.send.mock.calls[0]![0].confirmationUrl;
    const confirm = await app.inject({ method: "GET", url: confirmationUrl.replace("https://ipop.ai", "") });
    expect(confirm.statusCode).toBe(200);
    expect(followup.handle).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("lists workspace-scoped inbound leads with status/since/limit filters", async () => {
    listLeads.mockResolvedValueOnce([{ id: "lead-1", email: "ada@example.com", status: "new" }]);
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({
      method: "GET",
      url: "/me/inbound/leads?status=new&sinceMs=123&limit=25",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().leads).toHaveLength(1);
    expect(listLeads).toHaveBeenCalledWith(OWNER_WID, { status: "new", sinceMs: 123, limit: 25 });
    await app.close();
  });

  it("lists captured leads from the authenticated workspace endpoint", async () => {
    listLeads.mockResolvedValueOnce([
      {
        id: "lead-1",
        workspaceId: OWNER_WID,
        name: "Ada",
        email: "ada@example.com",
        message: "Need help turning leads into revenue",
        source: "landing_form",
        trackingRef: "utm-1",
        status: "new",
        assigneeMemberId: null,
        nextAction: null,
        respondedAtMs: null,
        slaDueAtMs: 123456,
        slaNotifiedAtMs: null,
        slaBreached: false,
        reachContactKey: "email:ada@example.com",
        createdAtMs: 123000,
      },
    ]);
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${OWNER_WID}/leads?status=new&sinceMs=100&limit=10`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().leads).toEqual([
      expect.objectContaining({
        id: "lead-1",
        email: "ada@example.com",
        message: "Need help turning leads into revenue",
        status: "new",
      }),
    ]);
    expect(listLeads).toHaveBeenCalledWith(OWNER_WID, { status: "new", sinceMs: 100, limit: 10 });
    await app.close();
  });

  it("exports captured leads as authenticated workspace CSV", async () => {
    listLeads.mockResolvedValueOnce([
      {
        id: "lead-1",
        workspaceId: OWNER_WID,
        name: "Ada, CEO",
        email: "ada@example.com",
        message: 'Need "sales" help\nthis week',
        source: "landing_form",
        trackingRef: null,
        status: "working",
        assigneeMemberId: null,
        nextAction: "Reply today",
        respondedAtMs: null,
        slaDueAtMs: 123456,
        slaNotifiedAtMs: null,
        slaBreached: false,
        reachContactKey: "email:ada@example.com",
        createdAtMs: 123000,
      },
    ]);
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${OWNER_WID}/leads/export.csv?status=working`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="inbound-leads.csv"');
    expect(res.body).toContain("id,email,name,message,source,trackingRef,status");
    expect(res.body).toContain('"Ada, CEO"');
    expect(res.body).toContain('"Need ""sales"" help\nthis week"');
    expect(res.body).toContain(",working,");
    expect(listLeads).toHaveBeenCalledWith(OWNER_WID, {
      status: "working",
      sinceMs: undefined,
      limit: undefined,
    });
    await app.close();
  });

  it("rejects cross-workspace lead reads and exports", async () => {
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery());
    const otherWid = "99999999-2222-3333-4444-555555555555";
    const list = await app.inject({ method: "GET", url: `/workspaces/${otherWid}/leads` });
    const csv = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWid}/leads/export.csv`,
    });

    expect(list.statusCode).toBe(403);
    expect(csv.statusCode).toBe(403);
    expect(listLeads).not.toHaveBeenCalled();
    await app.close();
  });

  it("notifies the owner once for breached 24h SLA leads", async () => {
    listLeads.mockResolvedValueOnce([
      {
        id: "lead-1",
        name: "Ada",
        email: "ada@example.com",
        message: "Need a reply",
        status: "new",
        slaBreached: true,
        slaNotifiedAtMs: null,
      },
    ]);
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({ method: "GET", url: "/me/inbound/leads" });
    expect(res.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "inbound_lead",
        excerpt: expect.stringContaining("24h SLA breached"),
      }),
    );
    expect(markSlaNotified).toHaveBeenCalledWith(OWNER_WID, "lead-1");
    await app.close();
  });

  it("returns one full lead and patches status/assignee/next action", async () => {
    getLead.mockResolvedValueOnce({ id: "lead-1", message: "full message", status: "new" });
    updateLead.mockResolvedValueOnce({
      id: "lead-1",
      status: "working",
      assigneeMemberId: "22222222-2222-3333-4444-555555555555",
    });
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery());
    const got = await app.inject({ method: "GET", url: "/me/inbound/leads/lead-1" });
    expect(got.statusCode).toBe(200);
    expect(got.json().lead.message).toBe("full message");
    const patched = await app.inject({
      method: "PATCH",
      url: "/me/inbound/leads/lead-1",
      payload: {
        status: "working",
        assigneeMemberId: "22222222-2222-3333-4444-555555555555",
        nextAction: "Reply today",
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(updateLead).toHaveBeenCalledWith(
      OWNER_WID,
      "lead-1",
      expect.objectContaining({
        status: "working",
        assigneeMemberId: "22222222-2222-3333-4444-555555555555",
        nextAction: "Reply today",
      }),
    );
    await app.close();
  });

  it("rejects invalid lead status updates", async () => {
    const { app } = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({
      method: "PATCH",
      url: "/me/inbound/leads/lead-1",
      payload: { status: "lost" },
    });
    expect(res.statusCode).toBe(400);
    expect(updateLead).not.toHaveBeenCalled();
    await app.close();
  });
});
