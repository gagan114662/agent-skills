import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { sreIncidentStore } from "../../src/db/repositories/sre.js";
import { createAgentMember } from "../../src/db/repositories/members.js";
import { channelPoster } from "../../src/runtime/default.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import {
  ensureOverlay,
  setOverlayChannel,
  setInvestigationNote,
  recordOverlayPaged,
  getOverlay,
  ackIncident,
  recordPage,
  countPagesSince,
  listPages,
  getWorkspaceOwnerContact,
} from "../../src/db/repositories/reliability.js";
import { createReliabilityNotifier } from "../../src/reliability/default.js";
import type { SreNotifier } from "../../src/sre/engine.js";
import type { IncidentRecord } from "../../src/sre/types.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

const silentLogger: SessionLogger = { child: () => silentLogger, info: () => {}, warn: () => {}, error: () => {} };

const app: FastifyInstance = buildApp();
const slugs: string[] = [];
const managedDir = mkdtempSync(join(tmpdir(), "reliability-managed-"));

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  delete process.env.RELOAD_MANAGED_CONFIG;
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  cookie: string;
  email: string;
  slug: string;
}

async function seed(): Promise<World> {
  const slug = `rel-${newId()}`;
  slugs.push(slug);
  const email = `u-${newId()}@e.com`;
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { workspaceId: me.workspaceId, cookie, email, slug };
}

/** Opt a workspace into reliability via a managed-layer per-tenant override, and point the loader at it. */
function optInManaged(workspaceId: string, opts: { enabled?: boolean; statusPageEnabled?: boolean }): void {
  const path = join(managedDir, `${workspaceId}.toml`);
  writeFileSync(
    path,
    `[workspace.${workspaceId}.reliability]\n` +
      (opts.enabled ? "enabled = true\n" : "") +
      (opts.statusPageEnabled ? "statusPageEnabled = true\n" : ""),
    "utf8",
  );
  process.env.RELOAD_MANAGED_CONFIG = path;
}

function incident(workspaceId: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  const now = new Date();
  return {
    id: newId(),
    workspaceId,
    service: "api",
    sloKind: "availability",
    severity: "critical",
    status: "firing",
    observedValue: 0.42,
    targetValue: 0.99,
    budgetRemaining: 0,
    triageSessionId: null,
    postmortemPath: null,
    openedAt: now,
    lastNotifiedAt: now,
    resolvedAt: null,
    ...overrides,
  };
}

describe("reliability — owner contact + overlay + pages repos", () => {
  it("resolves the workspace owner's verified email (members → users join)", async () => {
    const w = await seed();
    const owner = await getWorkspaceOwnerContact(w.workspaceId);
    expect(owner).not.toBeNull();
    expect(owner!.email).toBe(w.email);
  });

  it("manages the incident overlay lifecycle (seq, channel, note, paging, ack)", async () => {
    const w = await seed();
    const incidentId = newId();

    const overlay = await ensureOverlay(w.workspaceId, incidentId);
    expect(overlay.seq).toBe(1);
    // Idempotent: a second ensure returns the same row, not a new seq.
    expect((await ensureOverlay(w.workspaceId, incidentId)).id).toBe(overlay.id);

    await setOverlayChannel(overlay.id, newId());
    await setInvestigationNote(overlay.id, "## 🔎 AI investigation\nlikely cause");
    await recordOverlayPaged(overlay.id, new Date());
    await recordOverlayPaged(overlay.id, new Date());

    const after = await getOverlay(incidentId);
    expect(after!.channelId).not.toBeNull();
    expect(after!.investigationNote).toContain("AI investigation");
    expect(after!.pageCount).toBe(2);
    expect(after!.ackedAt).toBeNull();

    const acked = await ackIncident(w.workspaceId, incidentId, new Date());
    expect(acked!.ackedAt).not.toBeNull();
  });

  it("audits pages and counts only DELIVERED ones in the rate-limit window", async () => {
    const w = await seed();
    const since = new Date(Date.now() - 60_000);
    await recordPage({ workspaceId: w.workspaceId, source: "sre", incidentId: newId(), kind: "opened", recipient: "o@e.com", delivered: true, suppressedReason: null });
    await recordPage({ workspaceId: w.workspaceId, source: "sre", incidentId: newId(), kind: "repaged", recipient: "o@e.com", delivered: false, suppressedReason: "quiet_hours" });
    await recordPage({ workspaceId: w.workspaceId, source: "uptime", incidentId: null, kind: "uptime_down", recipient: "o@e.com", delivered: true, suppressedReason: null });

    expect(await countPagesSince(w.workspaceId, since)).toBe(2); // the suppressed one is excluded
    expect((await listPages(w.workspaceId)).length).toBe(3); // all attempts are audited
  });
});

describe("reliability — public status page (default-OFF, opt-in)", () => {
  it("404s for a workspace that has not opted in", async () => {
    const w = await seed();
    delete process.env.RELOAD_MANAGED_CONFIG; // ensure not opted in
    const res = await app.inject({ method: "GET", url: `/status/${w.slug}` });
    expect(res.statusCode).toBe(404);
  });

  it("404s for an unknown slug", async () => {
    const res = await app.inject({ method: "GET", url: `/status/does-not-exist-${newId()}` });
    expect(res.statusCode).toBe(404);
  });

  it("serves a redacted status page once opted in", async () => {
    const w = await seed();
    // Seed a firing incident with internal numbers that must NOT leak publicly.
    await sreIncidentStore.open({
      workspaceId: w.workspaceId,
      service: "api",
      sloKind: "availability",
      severity: "critical",
      observedValue: 0.4242,
      targetValue: 0.99,
      budgetRemaining: 0,
      now: new Date(),
    });
    optInManaged(w.workspaceId, { statusPageEnabled: true });

    const res = await app.inject({ method: "GET", url: `/status/${w.slug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overall).toBe("major_outage"); // active critical incident
    expect(body.incidents[0].service).toBe("api");
    expect(body.incidents[0]).not.toHaveProperty("observedValue");
    expect(res.payload).not.toContain("0.4242"); // the internal observed value never crosses the boundary
    delete process.env.RELOAD_MANAGED_CONFIG;
  });
});

describe("reliability — ack route (tenant-scoped)", () => {
  it("acks an incident and is cross-tenant safe", async () => {
    const a = await seed();
    const b = await seed();
    const incidentId = newId();
    await ensureOverlay(a.workspaceId, incidentId);

    // B cannot ack A's incident: assertWorkspace blocks it (403).
    const cross = await app.inject({
      method: "POST",
      url: `/workspaces/${a.workspaceId}/reliability/incidents/${incidentId}/ack`,
      cookies: { rid: b.cookie },
    });
    expect(cross.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: `/workspaces/${a.workspaceId}/reliability/incidents/${incidentId}/ack`,
      cookies: { rid: a.cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);

    const overlay = await getOverlay(incidentId);
    expect(overlay!.ackedAt).not.toBeNull();
  });
});

describe("reliability — coordinator end-to-end", () => {
  it("on open: creates the #incident-NNN war-room, posts the timeline + investigation, stores the note, and audits a page", async () => {
    const w = await seed();
    optInManaged(w.workspaceId, { enabled: true });
    const agent = await createAgentMember({ workspaceId: w.workspaceId, name: "oncall" });

    const notifier: SreNotifier = createReliabilityNotifier({
      fallback: { notify: async () => {} },
      poster: async () => ({ agentMemberId: agent.id }),
      channelPost: async (input) => {
        await channelPoster.post(input);
      },
      logger: silentLogger,
    });

    const inc = incident(w.workspaceId);
    await sreIncidentStore.open({
      workspaceId: w.workspaceId, service: inc.service, sloKind: inc.sloKind, severity: inc.severity,
      observedValue: inc.observedValue, targetValue: inc.targetValue, budgetRemaining: 0, now: inc.openedAt,
    });

    await notifier.notify({ workspaceId: w.workspaceId, incident: inc, kind: "opened" });

    const overlay = await getOverlay(inc.id);
    expect(overlay).not.toBeNull();
    expect(overlay!.seq).toBe(1);
    expect(overlay!.channelId).not.toBeNull();
    expect(overlay!.investigationNote).toContain("AI investigation");

    const msgs = await listChannelMessages(overlay!.channelId as string);
    expect(msgs.some((m) => m.body.toLowerCase().includes("detected"))).toBe(true);
    expect(msgs.some((m) => m.body.includes("AI investigation"))).toBe(true);

    // The owner was paged via the log transport (delivered) and the attempt is audited.
    const pages = await listPages(w.workspaceId);
    expect(pages.some((p) => p.source === "sre" && p.kind === "opened")).toBe(true);
    delete process.env.RELOAD_MANAGED_CONFIG;
  });
});
