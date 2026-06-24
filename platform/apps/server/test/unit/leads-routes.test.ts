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
const listLeads = vi.fn(async () => []);
const getLead = vi.fn(async () => null);
const updateLead = vi.fn(async () => null);
const markSlaNotified = vi.fn(async () => true);
const getWorkspaceOwnerMemberId = vi.fn(async () => "33333333-2222-3333-4444-555555555555");
const notify = vi.fn(async () => ({ id: "notif-1" }));
vi.mock("../../src/db/repositories/inbound-leads.js", () => ({ recordLead, listLeads, getLead, updateLead, markSlaNotified }));
vi.mock("../../src/db/repositories/members.js", () => ({ getWorkspaceOwnerMemberId }));
vi.mock("../../src/notifications/service.js", () => ({ notify }));
vi.mock("../../src/auth/guard.js", () => ({
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
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(inboundLeadsRoutes, {
    discovery: discovery as unknown as Parameters<typeof inboundLeadsRoutes>[1]["discovery"],
    ownerWorkspaceId,
    warmLeadFollowup,
  });
  await app.ready();
  return app;
}

function fakeDiscovery(impl?: () => Promise<unknown>): FakeDiscovery {
  return {
    defineSignal: vi.fn(async () => ({})),
    ingestSignal: vi.fn(impl ?? (async () => ({ signal: {}, pqls: [] }))),
  };
}

beforeEach(() => {
  resetMetrics();
  recordLead.mockClear();
  listLeads.mockClear();
  getLead.mockClear();
  updateLead.mockClear();
  markSlaNotified.mockClear();
  getWorkspaceOwnerMemberId.mockClear();
  notify.mockClear();
});

describe("POST /inbound/leads (public capture)", () => {
  it("persists a clean lead, qualifies it, triggers follow-up, and returns 202 {received:true}", async () => {
    const disc = fakeDiscovery();
    const followup = { handle: vi.fn(async () => undefined) };
    const app = await buildRoute(OWNER_WID, disc, followup);
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { name: "Ada", email: "ada@example.com", message: "fix our SEO" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ received: true });
    expect(recordLead).toHaveBeenCalledTimes(1);
    expect(recordLead.mock.calls[0]![0]).toMatchObject({
      workspaceId: OWNER_WID,
      email: "ada@example.com",
      message: "fix our SEO",
      source: "landing_form",
    });
    // Best-effort discovery feed: a default role_match definition plus an opaque (non-email) prospect key.
    expect(disc.defineSignal).toHaveBeenCalledWith(OWNER_WID, expect.objectContaining({
      kind: "role_match",
      label: "inbound_lead_default",
      role: "inbound_lead",
      threshold: 1,
      weight: 100,
    }));
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
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: OWNER_WID,
      recipientMemberId: "33333333-2222-3333-4444-555555555555",
      type: "inbound_lead",
      excerpt: expect.stringContaining("New inbound lead from Ada <ada@example.com>"),
    }));
    await app.close();
  });

  it("rejects an empty email/message with 400 and persists nothing", async () => {
    const app = await buildRoute(OWNER_WID, fakeDiscovery());
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
    await app.close();
  });

  it("503s when no owner workspace is configured and no body wid given", async () => {
    const app = await buildRoute(undefined, fakeDiscovery());
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(recordLead).not.toHaveBeenCalled();
    await app.close();
  });

  it("never lets a non-owner workspaceId in the body redirect the lead", async () => {
    const app = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "hi", workspaceId: "99999999-2222-3333-4444-555555555555" },
    });
    expect(res.statusCode).toBe(400);
    expect(recordLead).not.toHaveBeenCalled();
    await app.close();
  });

  it("still returns 202 when the discovery feed throws (capture must not fail)", async () => {
    const disc = fakeDiscovery(async () => {
      throw new Error("discovery down");
    });
    const app = await buildRoute(OWNER_WID, disc);
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(recordLead).toHaveBeenCalledTimes(1); // the lead was persisted before discovery ran
    expect(renderMetrics()).toContain('async_side_effect_failures_total{kind="inbound_lead_discovery_ingest"} 1');
    await app.close();
  });

  it("still returns 202 when warm follow-up throws (capture must not fail)", async () => {
    const followup = { handle: vi.fn(async () => { throw new Error("reach down"); }) };
    const app = await buildRoute(OWNER_WID, fakeDiscovery(), followup);
    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: { email: "a@b.co", message: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(recordLead).toHaveBeenCalledTimes(1);
    expect(followup.handle).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("lists workspace-scoped inbound leads with status/since/limit filters", async () => {
    listLeads.mockResolvedValueOnce([{ id: "lead-1", email: "ada@example.com", status: "new" }]);
    const app = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({ method: "GET", url: "/me/inbound/leads?status=new&sinceMs=123&limit=25" });
    expect(res.statusCode).toBe(200);
    expect(res.json().leads).toHaveLength(1);
    expect(listLeads).toHaveBeenCalledWith(OWNER_WID, { status: "new", sinceMs: 123, limit: 25 });
    await app.close();
  });

  it("notifies the owner once for breached 24h SLA leads", async () => {
    listLeads.mockResolvedValueOnce([{
      id: "lead-1",
      name: "Ada",
      email: "ada@example.com",
      message: "Need a reply",
      status: "new",
      slaBreached: true,
      slaNotifiedAtMs: null,
    }]);
    const app = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({ method: "GET", url: "/me/inbound/leads" });
    expect(res.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "inbound_lead",
      excerpt: expect.stringContaining("24h SLA breached"),
    }));
    expect(markSlaNotified).toHaveBeenCalledWith(OWNER_WID, "lead-1");
    await app.close();
  });

  it("returns one full lead and patches status/assignee/next action", async () => {
    getLead.mockResolvedValueOnce({ id: "lead-1", message: "full message", status: "new" });
    updateLead.mockResolvedValueOnce({ id: "lead-1", status: "working", assigneeMemberId: "22222222-2222-3333-4444-555555555555" });
    const app = await buildRoute(OWNER_WID, fakeDiscovery());
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
    expect(updateLead).toHaveBeenCalledWith(OWNER_WID, "lead-1", expect.objectContaining({
      status: "working",
      assigneeMemberId: "22222222-2222-3333-4444-555555555555",
      nextAction: "Reply today",
    }));
    await app.close();
  });

  it("rejects invalid lead status updates", async () => {
    const app = await buildRoute(OWNER_WID, fakeDiscovery());
    const res = await app.inject({ method: "PATCH", url: "/me/inbound/leads/lead-1", payload: { status: "lost" } });
    expect(res.statusCode).toBe(400);
    expect(updateLead).not.toHaveBeenCalled();
    await app.close();
  });
});
