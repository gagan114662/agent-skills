import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { AutomationEngine } from "../../src/automations/engine.js";
import { automationStore } from "../../src/db/repositories/automations.js";
import { createAgentSession, markSessionRunning } from "../../src/db/repositories/agent-sessions.js";
import { createRequest } from "../../src/db/repositories/approvals.js";

/** Records what the fake launcher was asked to launch (no real session, no model spend). */
const launches: Array<{ workspaceId: string; channelId: string; agentMemberId: string; task: string }> = [];
/** Flipped per-scenario to exercise the default-OFF gate + the rate cap. */
let capsEnabled = true;
let maxRunsPerWindow = 10;

/**
 * The injected AutomationEngine: the REAL store (so persistence + tenant isolation are proven against
 * Postgres) but a FAKE launcher (returns a uuid — the soft-FK session id — and records the call) and a
 * stubbed agent-member resolver (so the test needn't seed a full #123 department). Caps are driven by
 * the mutable module vars so a single app exercises enabled/disabled + the rate limit.
 */
function makeEngine(): AutomationEngine {
  return new AutomationEngine({
    store: automationStore,
    launcher: {
      launch: async (input) => {
        launches.push({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          agentMemberId: input.agentMemberId,
          task: input.task,
        });
        return { id: newId() };
      },
    },
    resolveAgentMember: async () => ({ agentMemberId: newId() }),
    caps: () => ({ enabled: capsEnabled, maxRunsPerWindow, windowMinutes: 60, maxPerWorkspace: 50 }),
    killSwitch: async () => false,
    logger: { info() {}, warn() {}, error() {}, child() { return this; } } as never,
  });
}

const engine = makeEngine();
const app: FastifyInstance = buildApp({ automations: engine });
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  cookie: string;
  channelId: string;
}

/** Sign up a human + make an SEO channel (so the department→agent derivation resolves to `scout`). */
async function seed(): Promise<World> {
  const slug = `au-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "seo" },
  });
  return { workspaceId: me.workspaceId, cookie, channelId: channel.json().id };
}

const post = (w: World, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie }, payload });
const get = (w: World, url: string) =>
  app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie } });

describe("automations (real Postgres): scheduled/webhook agent tasks through the #123 gated path", () => {
  it(
    "creates + lists + toggles automations, runs them manually + on the scheduler tick + via webhook " +
      "through the (fake) gated launcher, enforces the rate cap + default-OFF, and isolates tenants",
    async () => {
      capsEnabled = true;
      maxRunsPerWindow = 10;
      launches.length = 0;
      const w = await seed();
      const other = await seed(); // a sibling — must see none of w's automations

      // (1) the task-template gallery for the SEO channel resolves to the seo_audit template.
      const templates = (await get(w, `/task-templates?channel=${w.channelId}`)).json();
      expect(templates.map((t: { key: string }) => t.key)).toContain("seo_audit");

      // (2) create a daily schedule automation (the "every day Scout audits the site" brief).
      const created = await post(w, "/automations", {
        name: "Daily SEO audit",
        triggerKind: "schedule",
        schedule: { cadence: "daily", hour: 9, minute: 0 },
        templateKey: "seo_audit",
        params: { site: "ipop.ai" },
        channelId: w.channelId,
        enabled: true,
      });
      expect(created.statusCode).toBe(201);
      const automationId = created.json().id;
      expect(created.json().agentHandle).toBe("scout"); // derived from the SEO channel
      expect(created.json().nextRunAt).toBeTruthy();

      // it is listed for w, and NOT for the sibling tenant.
      expect((await get(w, "/automations")).json()).toHaveLength(1);
      expect((await get(other, "/automations")).json()).toHaveLength(0);

      // (3) run it now (manual): the fake gated launcher fires, a `launched` run is recorded with the
      // rendered task (the template body, params substituted) + the session id.
      const run = await post(w, `/automations/${automationId}/run`);
      expect(run.statusCode).toBe(202);
      expect(run.json()).toMatchObject({ status: "launched", trigger: "manual" });
      expect(run.json().sessionId).toBeTruthy();
      expect(launches).toHaveLength(1);
      expect(launches[0].task).toContain("ipop.ai");
      expect(launches[0].channelId).toBe(w.channelId);

      // (4) the rate cap: drop the window to 1; a second manual run is recorded `skipped`.
      maxRunsPerWindow = 1;
      const capped = await post(w, `/automations/${automationId}/run`);
      expect(capped.json()).toMatchObject({ status: "skipped", reason: "rate_limited" });
      expect(launches).toHaveLength(1); // no new launch
      maxRunsPerWindow = 10;

      // (5) default-OFF: when caps are disabled, even a manual run is a no-op `skipped`.
      capsEnabled = false;
      const off = await post(w, `/automations/${automationId}/run`);
      expect(off.json()).toMatchObject({ status: "skipped", reason: "automations_disabled" });
      capsEnabled = true;

      // (6) the scheduler tick: backdate the cursor and drive tickWorkspace directly — the due
      // automation launches and its cursor advances past now.
      await automationStore.markRan({
        id: automationId,
        lastRunAt: new Date("2026-01-01T00:00:00Z"),
        nextRunAt: new Date("2026-01-01T00:00:00Z"),
      });
      const before = launches.length;
      const now = new Date();
      const tick = await engine.tickWorkspace(w.workspaceId, now);
      expect(tick.runs.some((r) => r.status === "launched")).toBe(true);
      expect(launches.length).toBe(before + 1);
      const after = await automationStore.get(w.workspaceId, automationId);
      expect(after!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());

      // (7) a webhook automation returns its token ONCE; the public hook route fires it.
      const hook = await post(w, "/automations", {
        name: "Inbound audit",
        triggerKind: "webhook",
        templateKey: "seo_audit",
        channelId: w.channelId,
        enabled: true,
      });
      const token = hook.json().webhookToken as string;
      expect(token).toMatch(/^whk_/);
      const fired = await app.inject({ method: "POST", url: `/automations/hooks/${token}` });
      expect(fired.statusCode).toBe(202);
      expect(fired.json().status).toBe("launched");
      // an unknown token is a 404.
      expect((await app.inject({ method: "POST", url: "/automations/hooks/whk_nope" })).statusCode).toBe(404);

      // (8) toggle off, then delete.
      const toggled = await post(w, `/automations/${automationId}/enable`, { enabled: false });
      expect(toggled.json().enabled).toBe(false);
      const del = await app.inject({
        method: "DELETE",
        url: `/workspaces/${w.workspaceId}/automations/${automationId}`,
        cookies: { rid: w.cookie },
      });
      expect(del.statusCode).toBe(204);
    },
  );

  it("the audit trail merges approval requests + automation runs (tenant-scoped, newest first)", async () => {
    const w = await seed();
    await post(w, "/automations", {
      name: "A",
      triggerKind: "schedule",
      schedule: { cadence: "daily", hour: 9 },
      templateKey: "seo_audit",
      channelId: w.channelId,
      enabled: true,
    });
    const id = (await get(w, "/automations")).json()[0].id;
    await post(w, `/automations/${id}/run`); // a launched run

    const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: w.cookie } })).json();
    await createRequest({
      workspaceId: w.workspaceId,
      requesterMemberId: me.memberId,
      actionType: "external.send",
      payload: {},
      amount: null,
      summary: "Post the launch tweet",
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested" }],
    });

    const audit = (await get(w, "/audit")).json();
    expect(audit.some((e: { source: string }) => e.source === "approval")).toBe(true);
    expect(audit.some((e: { source: string }) => e.source === "automation")).toBe(true);
    // tenant isolation: a fresh sibling sees an empty feed.
    const other = await seed();
    expect((await get(other, "/audit")).json()).toEqual([]);
  });

  it("mission control lists a tenant's live sessions with elapsed + estimated spend, and guards controls", async () => {
    const w = await seed();
    const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: w.cookie } })).json();
    const session = await createAgentSession({
      workspaceId: w.workspaceId,
      channelId: w.channelId,
      agentMemberId: me.memberId,
      createdByMemberId: me.memberId,
      runtime: "local",
      command: "noop",
      caps: { wallClockMs: 60000, idleMs: 60000 },
    });
    await markSessionRunning(session.id);

    const mc = (await get(w, "/mission-control")).json();
    expect(mc.count).toBe(1);
    expect(mc.sessions[0].id).toBe(session.id);
    expect(mc.costIsEstimate).toBe(true);

    // a sibling tenant cannot stop w's session (the #19 boundary).
    const other = await seed();
    const foreign = await app.inject({
      method: "POST",
      url: `/workspaces/${other.workspaceId}/mission-control/sessions/${session.id}/stop`,
      cookies: { rid: other.cookie },
    });
    expect(foreign.statusCode).toBe(404);

    // the owner can stop it (best-effort; not in-process here so canceled is false, but the route acts).
    const stop = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/mission-control/sessions/${session.id}/stop`,
      cookies: { rid: w.cookie },
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toHaveProperty("canceled");
  });
});
