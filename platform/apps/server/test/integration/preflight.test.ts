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
import type { PreflightReport } from "../../src/runtime/preflight.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `pf-${newId()}`;
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
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

/** A misconfigured `prod` posture report — what `defaultPreflight()` returns with no Vercel auth. */
const failingReport: PreflightReport = {
  profile: "prod",
  runtime: "sandbox",
  harness: "claude-code",
  ok: false,
  checks: [
    {
      name: "vercel-auth",
      status: "fail",
      message: "no Vercel auth — set VERCEL_OIDC_TOKEN, or the access-token trio",
      remedy: "Authenticate with VERCEL_OIDC_TOKEN, or set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.",
    },
  ],
};

function newApp(opts: Parameters<typeof buildApp>[0]): FastifyInstance {
  const app = buildApp(opts);
  apps.push(app);
  return app;
}

describe("preflight / doctor (#69 — real Postgres + Redis, LocalRuntime, no cloud)", () => {
  it("GET /preflight returns the posture report to an authenticated member", async () => {
    const okReport: PreflightReport = {
      profile: "dev",
      runtime: "local",
      harness: "demo",
      ok: true,
      checks: [{ name: "runtime", status: "pass", message: "runtime 'local' needs no cloud credentials" }],
    };
    const app = newApp({ preflight: () => okReport });
    const w = await seed(app);

    const res = await app.inject({ method: "GET", url: "/preflight", cookies: { rid: w.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ profile: "dev", runtime: "local", harness: "demo", ok: true });
  });

  it("GET /preflight requires identity (401 without a session)", async () => {
    const app = newApp({});
    const res = await app.inject({ method: "GET", url: "/preflight" });
    expect(res.statusCode).toBe(401);
  });

  it("a launch under a failing preflight is rejected 412 — with no session row created (no cloud call)", async () => {
    const manager = new SessionManager({
      runtime: new LocalRuntime(),
      store: dbStore,
      poster: channelPoster,
      secrets: new StaticSecretsResolver({}),
      harness: { command: process.execPath, args: ["-e", "0"] },
      caps: { wallClockMs: 5_000, idleMs: 5_000 },
      logger: silentLogger,
      preflight: () => failingReport, // simulate a misconfigured prod posture
    });
    const app = newApp({ sessionManager: manager });
    const w = await seed(app);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "do the thing" },
    });
    expect(launch.statusCode).toBe(412);
    const body = launch.json();
    expect(body.error).toContain("preflight");
    expect(body.preflight.ok).toBe(false);
    expect(body.preflight.checks[0].name).toBe("vercel-auth");
    // the actionable message names a variable but never a secret value
    expect(JSON.stringify(body)).not.toMatch(/sk-|VERCEL_OIDC_TOKEN=/);

    // Nothing was persisted — the channel has no agent sessions.
    const list = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
    });
    expect(list.json()).toHaveLength(0);
  });
});
