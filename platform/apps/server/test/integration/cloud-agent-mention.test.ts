import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import {
  SubscriptionSecretsResolver,
  StaticSecretsResolver,
} from "../../src/runtime/secrets-resolver.js";
import { createAgentAuthResolver } from "../../src/runtime/auth-default.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { createScale } from "../../src/scale/default.js";
import { setWorkspaceClaudeToken } from "../../src/db/repositories/agent-credentials.js";

/**
 * #68 — the headline proof: an @mention of a fleet agent on the REAL (`claude-code`) harness posture
 * runs a session billed to the OWNER's connected Claude subscription, replies in-thread, and is
 * metered — and when no Claude is connected the persona posts a friendly connect prompt instead,
 * spending nothing.
 *
 * Auth is proven without model spend: a `node -e` echo "harness" prints back its AGENT_TASK and
 * whether `CLAUDE_CODE_OAUTH_TOKEN` was injected into the runtime env (the subscription token the
 * SubscriptionSecretsResolver resolved from the per-tenant vault). The deployment posture is forced to
 * `claude-code` so the auth gate engages (the demo harness needs no auth).
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// A spend-free stand-in for the claude-code harness: echo the task + whether the subscription token
// reached the runtime env. `auth=subscription` proves the OWNER's token was injected.
const ECHO_HARNESS = [
  "-e",
  "console.log('agent: task=' + (process.env.AGENT_TASK || 'none') + ' auth=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : 'none'));",
];

let app: FastifyInstance;
const slugs: string[] = [];
const savedHarness = process.env.AGENT_HARNESS;
const savedPlatformKey = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  // Force the REAL-harness posture so the #68 auth gate engages, and ensure NO operator platform key
  // so a workspace with no token resolves to mode:"none" (the connect-prompt path).
  process.env.AGENT_HARNESS = "claude-code";
  delete process.env.ANTHROPIC_API_KEY;

  const scale = createScale(0);
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    // The PRODUCTION resolver: per-tenant subscription token from the vault, no platform fallback.
    secrets: new SubscriptionSecretsResolver(createAgentAuthResolver(), new StaticSecretsResolver({})),
    harness: { command: process.execPath, args: ECHO_HARNESS },
    harnessKind: "claude-code",
    caps: { wallClockMs: 10_000, idleMs: 5_000 },
    logger: silentLogger,
    admission: scale.admission,
    usage: scale.usage,
  });
  app = buildApp({ sessionManager: manager, scale });
  await app.ready();
});

afterAll(async () => {
  if (savedHarness === undefined) delete process.env.AGENT_HARNESS;
  else process.env.AGENT_HARNESS = savedHarness;
  if (savedPlatformKey !== undefined) process.env.ANTHROPIC_API_KEY = savedPlatformKey;

  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function newOwner(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `c68-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId };
}

async function seedSeo(owner: { cookie: string; workspaceId: string }): Promise<{ id: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/department/seed`,
    cookies: { rid: owner.cookie },
    payload: {},
  });
  return res.json().channels.find((c: { name: string }) => c.name === "seo");
}

// Post a plain message that @mentions the agent — exactly what the web client does. The #123 post-time
// trigger (wired into the shared fan-out) launches the session; there is NO explicit `/marketing` call.
async function mention(owner: { cookie: string }, channelId: string, body: string) {
  const msg = (
    await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      cookies: { rid: owner.cookie },
      payload: { body },
    })
  ).json();
  return { msg };
}

// Poll the department task feed for the mention launch's session id (recorded asynchronously by the
// post-time trigger). Returns undefined if no launch happened (e.g. the connect-prompt path).
async function pollMentionSessionId(owner: { cookie: string; workspaceId: string }): Promise<string | undefined> {
  for (let i = 0; i < 80; i++) {
    const tasks = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/department/tasks`,
        cookies: { rid: owner.cookie },
      })
    ).json() as Array<{ kind: string; sessionId: string | null }>;
    const t = tasks.find((t) => t.kind === "mention" && t.sessionId);
    if (t) return t.sessionId!;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

async function waitForSession(owner: { cookie: string }, channelId: string, sessionId: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/agent-sessions/${sessionId}`,
      cookies: { rid: owner.cookie },
    });
    const status = res.json().status as string;
    if (["completed", "failed", "timeout", "idle_reaped", "canceled"].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("session did not finish");
}

async function threadText(owner: { cookie: string }, channelId: string, messageId: string): Promise<string> {
  const thread = (
    await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages/${messageId}/thread`,
      cookies: { rid: owner.cookie },
    })
  ).json();
  return (thread.replies as Array<{ body: string }>).map((r) => r.body).join("\n");
}

async function sessionsStarted(owner: { cookie: string; workspaceId: string }): Promise<number> {
  const usage = (
    await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/scale/usage`,
      cookies: { rid: owner.cookie },
    })
  ).json();
  return usage.sessionsStarted as number;
}

describe("#68 cloud agent @mention (real harness posture)", () => {
  it("with no Claude connected → posts a friendly connect prompt and spends nothing", async () => {
    const owner = await newOwner();
    const seo = await seedSeo(owner);

    const { msg } = await mention(owner, seo.id, "@scout audit the homepage");

    // The persona posted the brand-voice connect prompt in-thread instead of launching.
    let text = "";
    for (let i = 0; i < 80 && !/Connect Claude/i.test(text); i++) {
      text = await threadText(owner, seo.id, msg.id);
      if (!/Connect Claude/i.test(text)) await new Promise((r) => setTimeout(r, 100));
    }
    expect(text).toMatch(/Connect Claude/i);
    expect(text).toMatch(/setup-token/i);

    // No launch ⇒ no metering: the connect prompt never touched the admission/usage path. (The
    // connect-prompt path records no mention task either — only a real launch does.)
    expect(await sessionsStarted(owner)).toBe(0);
  });

  it("with the owner's subscription connected → runs a real session, replies, and meters usage", async () => {
    const owner = await newOwner();
    const seo = await seedSeo(owner);

    // The owner connects THEIR OWN Claude subscription (claude setup-token).
    await setWorkspaceClaudeToken({ workspaceId: owner.workspaceId, token: "oauth-tok-headline" });

    const { msg } = await mention(owner, seo.id, "@scout audit the homepage");
    const sessionId = await pollMentionSessionId(owner);
    expect(sessionId, "post-time trigger should have launched a session").toBeDefined();

    expect(await waitForSession(owner, seo.id, sessionId!)).toBe("completed");

    // The agent actually ran on the brief AND was authed by the owner's subscription token (injected
    // into the runtime env per tenant) — not a pooled platform key.
    const text = await threadText(owner, seo.id, msg.id);
    expect(text).toContain("agent: task=@scout audit the homepage");
    expect(text).toContain("auth=subscription");
    // The token value itself is redacted from everything the session posts/logs.
    expect(text).not.toContain("oauth-tok-headline");

    // The session was metered to this tenant.
    expect(await sessionsStarted(owner)).toBeGreaterThanOrEqual(1);
  });
});
