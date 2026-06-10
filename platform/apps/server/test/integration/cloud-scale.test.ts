import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { Admission } from "../../src/scale/admission.js";
import { createUsageRecorder, type Scale } from "../../src/scale/default.js";
import { usageStore, recordSessionCompute } from "../../src/db/repositories/tenant-usage.js";
import { getControls, setKillSwitch } from "../../src/db/repositories/autonomy.js";
import { windowKey } from "../../src/scale/usage.js";
import { CONFIG_DEFAULTS, type ResolvedConfig, type ScaleConfig } from "../../src/config/schema.js";
import type { ResourceCaps } from "../../src/db/repositories/agent-sessions.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// A real (host) harness via node -e: prints the task then exits 0 — no model spend.
const COMPLETING_HARNESS = [
  "-e",
  "console.log('agent: task=' + (process.env.AGENT_TASK || 'none'));" +
    "setTimeout(() => console.log('agent: done'), 30);",
];
const caps: ResourceCaps = { wallClockMs: 20_000, idleMs: 8_000 };

// Per-tenant scale policy the Admission/recorder read — set per test, keyed by workspace id. Using a
// config function (instead of a managed TOML file) keeps the test hermetic and deterministic.
const scaleByWs = new Map<string, ScaleConfig>();
const configFn = (workspaceId: string): ResolvedConfig => ({
  ...CONFIG_DEFAULTS,
  scale: scaleByWs.get(workspaceId) ?? {},
});

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Build an app whose SessionManager + usage route share ONE Admission over the test config. */
async function startApp(): Promise<{ app: FastifyInstance }> {
  const admission = new Admission({
    usage: usageStore,
    killSwitch: { isEngaged: async (ws) => (await getControls(ws)).killSwitch },
    config: configFn,
    globalMax: 0,
  });
  const scale: Scale = { admission, usage: createUsageRecorder(usageStore, configFn), config: configFn };
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: COMPLETING_HARNESS },
    caps,
    logger: silentLogger,
    admission: scale.admission,
    usage: scale.usage,
  });
  const app = buildApp({ sessionManager: manager, scale });
  apps.push(app);
  await app.ready();
  return { app };
}

interface World {
  cookie: string;
  workspaceId: string;
  memberId: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `cs-${newId()}`;
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
    cookie,
    workspaceId: me.workspaceId,
    memberId: me.memberId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

function launch(app: FastifyInstance, w: World, task = "do it") {
  return app.inject({
    method: "POST",
    url: `/channels/${w.channelId}/agent-sessions`,
    cookies: { rid: w.cookie },
    payload: { agentMemberId: w.agentMemberId, task },
  });
}

async function pollStatus(app: FastifyInstance, w: World, sessionId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const body = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions/${sessionId}`,
        cookies: { rid: w.cookie },
      })
    ).json();
    if (body.status === "completed" || body.status === "failed") return body;
    if (Date.now() > deadline) throw new Error(`stuck in ${body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("cloud scale (#71 — admission, budget, kill switch, placement, usage; real Postgres)", () => {
  it("a tenant budget cap halts new sessions (402) and the usage endpoint surfaces it", async () => {
    const { app } = await startApp();
    const w = await seed(app);
    // Cap the tenant at $1; accrue $1 of usage this window so the next launch is over budget.
    scaleByWs.set(w.workspaceId, { budgetCents: 100, computeRateCentsPerMinute: 1 });
    const window = windowKey(new Date());
    await recordSessionCompute(w.workspaceId, window, 6000, 100); // estimatedCostCents = 100

    const denied = await launch(app, w);
    expect(denied.statusCode).toBe(402);
    expect(denied.json().reason).toBe("budget_exceeded");

    const usage = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/scale/usage`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(usage.overBudget).toBe(true);
    expect(usage.estimatedCostCents).toBe(100);
    expect(usage.caps.budgetCents).toBe(100);
  });

  it("the #17 kill switch halts all launches (429), and disengaging admits again", async () => {
    const { app } = await startApp();
    const w = await seed(app);
    await setKillSwitch(w.workspaceId, true, w.memberId);

    const halted = await launch(app, w);
    expect(halted.statusCode).toBe(429);
    expect(halted.json().reason).toBe("kill_switch");

    await setKillSwitch(w.workspaceId, false, w.memberId);
    const admitted = await launch(app, w);
    expect(admitted.statusCode).toBe(202);
    await pollStatus(app, w, admitted.json().id);
  });

  it("places a session in an allowed region (persisted) and accrues usage", async () => {
    const { app } = await startApp();
    const w = await seed(app);
    scaleByWs.set(w.workspaceId, { regions: ["iad1", "sfo1"] });

    const res = await launch(app, w, "place me");
    expect(res.statusCode).toBe(202);
    const session = await pollStatus(app, w, res.json().id);
    expect(session.status).toBe("completed");
    expect(session.region).toBe("iad1"); // both at 0 → least-loaded picks allowed-order first

    const usage = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${w.workspaceId}/scale/usage`,
        cookies: { rid: w.cookie },
      })
    ).json();
    expect(usage.sessionsStarted).toBeGreaterThanOrEqual(1);
    expect(usage.caps.regions).toEqual(["iad1", "sfo1"]);
  });

  it("the usage endpoint is tenant-isolated (another tenant's wid is 403)", async () => {
    const { app } = await startApp();
    const a = await seed(app);
    const b = await seed(app);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${b.workspaceId}/scale/usage`, // B's tenant
      cookies: { rid: a.cookie }, // A's identity
    });
    expect(res.statusCode).toBe(403);
  });
});
