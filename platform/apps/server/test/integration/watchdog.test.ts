import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import {
  workspaces,
  agentSessions,
  approvalRequests,
  watchdogRevivals,
} from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createAgentSession } from "../../src/db/repositories/agent-sessions.js";
import { listLiveSessions } from "../../src/db/repositories/agent-sessions.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { watchdogRevivalStore } from "../../src/db/repositories/watchdog.js";
import {
  WatchdogEngine,
  type WatchdogEscalator,
  type SessionReviver,
} from "../../src/watchdog/engine.js";
import { WATCHDOG_DEFAULTS, type WatchdogCaps } from "../../src/watchdog/caps.js";
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
}

/** Sign up a human in a fresh workspace, make a channel, register an agent. */
async function seed(): Promise<World> {
  const slug = `wd-${newId()}`;
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
    payload: { name: "agents" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Scout" },
  });
  return {
    workspaceId: me.workspaceId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

/** Seed a real `running` agent session whose heartbeat is `ageMs` in the past (a stalled session). */
async function seedStaleSession(w: World, ageMs: number): Promise<string> {
  const session = await createAgentSession({
    workspaceId: w.workspaceId,
    channelId: w.channelId,
    agentMemberId: w.agentMemberId,
    createdByMemberId: w.agentMemberId,
    runtime: "local",
    command: "node",
    caps: { wallClockMs: 600_000, idleMs: 120_000 },
  });
  const stale = new Date(Date.now() - ageMs);
  await db
    .update(agentSessions)
    .set({ status: "running", startedAt: stale, lastHeartbeatAt: stale })
    .where(eq(agentSessions.id, session.id));
  return session.id;
}

/** A fake reviver that records launches and returns a synthetic replacement id (no real process). */
function fakeReviver(): SessionReviver & { calls: Array<{ workspaceId: string; channelId: string }> } {
  const calls: Array<{ workspaceId: string; channelId: string }> = [];
  return {
    calls,
    launch: async (input) => {
      calls.push({ workspaceId: input.workspaceId, channelId: input.channelId });
      return { id: newId() };
    },
  };
}

/** The real #13 escalation (so we assert a real `approval_requests` row lands). */
const escalator: WatchdogEscalator = {
  escalate: async ({ workspaceId, session, record, reason }) => {
    const req = await createRequest({
      workspaceId,
      requesterMemberId: session.agentMemberId,
      actionType: "watchdog.escalate",
      payload: { sessionId: session.id, rootSessionId: record.rootSessionId, reason },
      amount: null,
      summary: `Watchdog escalation: ${session.id} (${reason})`,
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { sessionId: session.id } }],
    });
    return { id: req.id };
  },
};

function buildEngine(
  reviver: SessionReviver,
  enabledWorkspaceIds: Set<string>,
  caps: WatchdogCaps,
): WatchdogEngine {
  return new WatchdogEngine({
    listLiveSessions,
    // Scope the supervisor to the workspaces this test owns — other workspaces stay disabled.
    caps: (workspaceId) =>
      enabledWorkspaceIds.has(workspaceId) ? caps : { ...WATCHDOG_DEFAULTS, enabled: false },
    killSwitch: async () => false,
    budgetExhausted: async () => false,
    revivals: watchdogRevivalStore,
    reviver,
    finalizeDead: async (sessionId, status) => {
      await db
        .update(agentSessions)
        .set({ status, endedAt: new Date() })
        .where(eq(agentSessions.id, sessionId));
    },
    escalator,
    logger: silentLogger,
    now: () => new Date(),
  });
}

describe("fleet watchdog (real Postgres): detect → revive → escalate", () => {
  it("revives a stalled session via the launcher and records a durable revival; escalates at the limit; isolates workspaces", async () => {
    const wRevive = await seed();
    const wEscalate = await seed();
    const wOther = await seed(); // enabled:false — must be untouched (per-workspace isolation)

    // (A) a stalled session in the revive workspace, no prior lineage.
    const reviveSession = await seedStaleSession(wRevive, 10 * 60_000);

    // (B) a stalled session in the escalate workspace, already at the per-window revival limit.
    const escalateSession = await seedStaleSession(wEscalate, 10 * 60_000);
    const record = await watchdogRevivalStore.createForRoot({
      workspaceId: wEscalate.workspaceId,
      rootSessionId: escalateSession,
      errorClass: "stalled",
    });
    await db
      .update(watchdogRevivals)
      .set({ revivals: 3, windowStartedAt: new Date() }) // 3 == default maxRevivalsPerWindow
      .where(eq(watchdogRevivals.id, record.id));

    // (C) a stalled session in a workspace where the watchdog is DISABLED — must stay running.
    const untouchedSession = await seedStaleSession(wOther, 10 * 60_000);

    const reviver = fakeReviver();
    const caps: WatchdogCaps = { ...WATCHDOG_DEFAULTS, enabled: true, staleCutoffMs: 1000 };
    const engine = buildEngine(
      reviver,
      new Set([wRevive.workspaceId, wEscalate.workspaceId]),
      caps,
    );

    await engine.tickAll();

    // (A) revived: dead row finalized, the launcher was called once for this workspace, a durable
    // revival row now points at a fresh replacement with the count bumped to 1.
    const [reviveRow] = await db
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, reviveSession));
    expect(reviveRow.status).toBe("failed");
    expect(reviver.calls.filter((c) => c.workspaceId === wRevive.workspaceId)).toHaveLength(1);
    const [reviveLineage] = await db
      .select()
      .from(watchdogRevivals)
      .where(eq(watchdogRevivals.workspaceId, wRevive.workspaceId));
    expect(reviveLineage.revivals).toBe(1);
    expect(reviveLineage.currentSessionId).not.toBe(reviveSession);
    expect(reviveLineage.status).toBe("active");

    // (B) escalated: NOT revived, a real #13 request landed, the lineage is marked escalated.
    expect(reviver.calls.filter((c) => c.workspaceId === wEscalate.workspaceId)).toHaveLength(0);
    const escalations = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.workspaceId, wEscalate.workspaceId),
          eq(approvalRequests.actionType, "watchdog.escalate"),
        ),
      );
    expect(escalations).toHaveLength(1);
    const [escalatedLineage] = await db
      .select()
      .from(watchdogRevivals)
      .where(eq(watchdogRevivals.id, record.id));
    expect(escalatedLineage.status).toBe("escalated");

    // (C) isolation: the disabled workspace's stalled session is untouched (still running, no launch).
    const [untouchedRow] = await db
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, untouchedSession));
    expect(untouchedRow.status).toBe("running");
    expect(reviver.calls.filter((c) => c.workspaceId === wOther.workspaceId)).toHaveLength(0);
  });
});
