import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, approvalRequests, sreIncidents } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { sreIncidentStore } from "../../src/db/repositories/sre.js";
import { SreEngine, type SreEscalator, type TriageLauncher } from "../../src/sre/engine.js";
import type { SreCaps } from "../../src/sre/caps.js";
import type { ServiceSignal } from "../../src/sre/types.js";
import type { SessionLogger } from "../../src/runtime/manager.js";

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
  channelId: string;
  agentMemberId: string;
  cookie: string;
}

async function seed(): Promise<World> {
  const slug = `sre-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "ops" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "OnCall" },
  });
  return {
    workspaceId: me.workspaceId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
    cookie,
  };
}

/** A counting fake triage launcher (no real agent spawned in the test). */
function fakeTriage(): TriageLauncher & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    launch: async () => {
      state.calls += 1;
      return { id: newId() };
    },
  };
}

/** Real #13 escalation (against a real member) so we assert a genuine approval_requests row lands. */
function makeEscalator(requesterMemberId: string): SreEscalator {
  return {
    escalate: async ({ workspaceId, incident, reason }) => {
      const req = await createRequest({
        workspaceId,
        requesterMemberId,
        actionType: "sre.remediate",
        payload: { incidentId: incident.id, service: incident.service, reason },
        amount: null,
        summary: `SRE remediation: ${incident.service} ${incident.sloKind} (${reason})`,
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested", detail: { incidentId: incident.id } }],
      });
      return { id: req.id };
    },
  };
}

function buildEngine(
  enabled: Set<string>,
  triage: TriageLauncher,
  target: World,
  writtenPaths: string[],
): SreEngine {
  const caps: SreCaps = {
    enabled: true,
    cooldownMs: 60_000,
    services: [
      { service: "api", targets: [{ kind: "availability", target: 0.99 }, { kind: "latency_p95", target: 500 }] },
    ],
  };
  return new SreEngine({
    readSignals: async () => new Map(),
    listWorkspaceIds: async () => [...enabled],
    caps: (wid) => (enabled.has(wid) ? caps : { ...caps, enabled: false }),
    killSwitch: async () => false,
    incidents: sreIncidentStore,
    triage,
    // Host triage in the seeded workspace's channel/agent.
    triageTarget: {
      resolve: async (wid) =>
        wid === target.workspaceId
          ? { channelId: target.channelId, agentMemberId: target.agentMemberId, createdByMemberId: target.agentMemberId }
          : null,
    },
    bundle: {
      context: async () => ({ recentDeploys: [], traceHints: ["trace-x"], runbookLinks: ["docs/playbooks/restore-runbook.md"] }),
    },
    escalator: makeEscalator(target.agentMemberId),
    notifier: { notify: async () => {} },
    // Capture the postmortem path instead of writing to disk in the test.
    postmortems: { write: async (path) => void writtenPaths.push(path) },
    logger: silentLogger,
    now: () => new Date(),
  });
}

const breachingSignal = (): Map<string, ServiceSignal> =>
  // availability 0.1 (critical) + p95 750ms (latency warning) → two incidents for `api`.
  new Map([
    ["api", { service: "api", windowRequests: 1000, windowErrors: 900, p95LatencyMs: 750, queueLagSeconds: 0, healthy: true }],
  ]);

const healthySignal = (): Map<string, ServiceSignal> =>
  new Map([
    ["api", { service: "api", windowRequests: 1000, windowErrors: 0, p95LatencyMs: 100, queueLagSeconds: 0, healthy: true }],
  ]);

describe("SRE loop (real Postgres): breach → incident + triage + #13 → resolve → postmortem", () => {
  it("induces a failure, opens incidents, launches triage, escalates, then resolves with a drafted postmortem linked from the Founder Console; isolates workspaces", async () => {
    const w = await seed();
    const wOther = await seed(); // loop disabled — must be untouched (isolation)
    const triage = fakeTriage();
    const writtenPaths: string[] = [];
    const engine = buildEngine(new Set([w.workspaceId]), triage, w, writtenPaths);

    // --- Tick 1: induced breach ---
    const signals = breachingSignal();
    await engine.tickWorkspace(w.workspaceId, signals, new Date());

    const openRows = await db
      .select()
      .from(sreIncidents)
      .where(eq(sreIncidents.workspaceId, w.workspaceId));
    expect(openRows).toHaveLength(2); // availability (critical) + latency (warning)
    expect(openRows.every((r) => r.status === "firing" || r.status === "escalated")).toBe(true);
    expect(triage.calls).toBeGreaterThanOrEqual(2); // a triage launch per opened incident

    // The critical availability breach enqueued a real #13 remediation approval.
    const approvals = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.workspaceId, w.workspaceId),
          eq(approvalRequests.actionType, "sre.remediate"),
        ),
      );
    expect(approvals).toHaveLength(1);
    const availIncident = openRows.find((r) => r.sloKind === "availability")!;
    expect(availIncident.status).toBe("escalated");
    expect(availIncident.severity).toBe("critical");

    // No postmortem yet — the incidents are still firing.
    expect(writtenPaths).toHaveLength(0);

    // --- Tick 2: recovery ---
    await engine.tickWorkspace(w.workspaceId, healthySignal(), new Date());

    const resolvedRows = await db
      .select()
      .from(sreIncidents)
      .where(eq(sreIncidents.workspaceId, w.workspaceId));
    expect(resolvedRows.every((r) => r.status === "resolved")).toBe(true);
    expect(resolvedRows.every((r) => r.postmortemPath !== null)).toBe(true);
    expect(writtenPaths).toHaveLength(2); // a postmortem drafted per resolved incident

    // The Founder Console (#104) surfaces the drafted postmortems read-only.
    const console = await app.inject({
      method: "GET",
      url: `/workspaces/${w.workspaceId}/founder-console`,
      cookies: { rid: w.cookie },
    });
    expect(console.statusCode).toBe(200);
    const postmortems = console.json().postmortems as Array<{ path: string; service: string }>;
    expect(postmortems.length).toBeGreaterThanOrEqual(2);
    expect(postmortems.every((p) => p.path.startsWith("docs/postmortems/"))).toBe(true);

    // --- Isolation: the disabled workspace never opened an incident ---
    const otherRows = await db
      .select()
      .from(sreIncidents)
      .where(eq(sreIncidents.workspaceId, wOther.workspaceId));
    expect(otherRows).toHaveLength(0);

    // The read-only SRE incidents route returns this workspace's incidents.
    const incidentsResp = await app.inject({
      method: "GET",
      url: `/workspaces/${w.workspaceId}/sre/incidents`,
      cookies: { rid: w.cookie },
    });
    expect(incidentsResp.statusCode).toBe(200);
    expect((incidentsResp.json().incidents as unknown[]).length).toBe(2);
  });
});
