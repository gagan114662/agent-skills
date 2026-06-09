import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * #52 — Multi-model / multi-provider selection + effort/Auto mode (real Postgres + LocalRuntime).
 *
 * Proves the acceptance criteria end-to-end through the REST launch path:
 *   - a session runs against a chosen model + provider (the selection env reaches the harness);
 *   - Bedrock resolves credentials without baking a secret (the use-bedrock flag is set, no API key);
 *   - effort changes the invocation (MAX_THINKING_TOKENS appears);
 *   - Auto mode uses two distinct models in one session (implement + plan model both in env);
 *   - a provider outside the tenant allow-list is refused with a 400;
 *   - the non-secret selection is persisted on the session row for audit.
 *
 * The harness is a cwd-independent `node -e` that echoes the provider/model selection env it received,
 * so the test asserts the exact env Claude Code would read natively actually reached the agent process.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Echoes the selection env (model, provider flags, effort, plan model) the harness received, then exits.
const SELECTION_HARNESS = [
  "-e",
  "console.log('sel: model=' + (process.env.ANTHROPIC_MODEL || 'none'));" +
    "console.log('sel: plan=' + (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'none'));" +
    "console.log('sel: bedrock=' + (process.env.CLAUDE_CODE_USE_BEDROCK || 'none'));" +
    "console.log('sel: region=' + (process.env.AWS_REGION || 'none'));" +
    "console.log('sel: thinking=' + (process.env.MAX_THINKING_TOKENS || 'none'));" +
    "console.log('sel: apikey=' + (process.env.ANTHROPIC_API_KEY ? 'present' : 'none'));",
];

let app: FastifyInstance;
let prevRepoConfig: string | undefined;
const slugs: string[] = [];

// A tenant policy (repo layer): allow several providers, pin a default model + an Auto-mode pair, and
// configure the Bedrock region. NON-SECRET only — provider creds never live in config.
const REPO_CONFIG = [
  `[models]`,
  `defaultProvider = "anthropic"`,
  `defaultModel = "claude-sonnet-4-6"`,
  `allowedProviders = ["anthropic", "bedrock", "vertex"]`,
  `defaultEffort = "off"`,
  `[models.auto]`,
  `planModel = "claude-opus-4-8"`,
  `implementModel = "claude-sonnet-4-6"`,
  `[models.providers.bedrock]`,
  `region = "us-east-1"`,
].join("\n");

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "reload-models-"));
  const cfgPath = join(dir, "settings.toml");
  writeFileSync(cfgPath, REPO_CONFIG, "utf8");
  prevRepoConfig = process.env.RELOAD_REPO_CONFIG;
  process.env.RELOAD_REPO_CONFIG = cfgPath; // the route's loadConfig(workspaceId) picks this up

  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}), // no secrets — Bedrock must still work (cred chain)
    harness: { command: process.execPath, args: SELECTION_HARNESS }, // node, cwd-independent
    caps: { wallClockMs: 10_000, idleMs: 5_000 },
    logger: silentLogger,
  });
  app = buildApp({ sessionManager: manager });
  await app.ready();
});

afterAll(async () => {
  if (prevRepoConfig === undefined) delete process.env.RELOAD_REPO_CONFIG;
  else process.env.RELOAD_REPO_CONFIG = prevRepoConfig;
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(): Promise<World> {
  const slug = `mp-${newId()}`;
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

async function launch(w: World, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/channels/${w.channelId}/agent-sessions`,
    cookies: { rid: w.cookie },
    payload: { agentMemberId: w.agentMemberId, task: "do the thing", ...body },
  });
}

async function waitForSession(w: World, sessionId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}`,
      cookies: { rid: w.cookie },
    });
    const body = res.json();
    if (["completed", "failed", "timeout", "idle_reaped", "canceled"].includes(body.status as string)) {
      return body;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("session did not finish in time");
}

async function streamedText(w: World, channelId: string): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: `/channels/${channelId}/messages`,
    cookies: { rid: w.cookie },
  });
  const msgs = res.json() as Array<{ body: string }>;
  return msgs.map((m) => m.body).join("\n");
}

describe("#52 model/provider selection (real Postgres + LocalRuntime)", () => {
  it("runs a session against a chosen model + effort and persists the selection", async () => {
    const w = await seed();
    const res = await launch(w, { provider: "anthropic", model: "claude-opus-4-8", effort: "high" });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.effort).toBe("high");

    expect((await waitForSession(w, body.id)).status).toBe("completed");
    const text = await streamedText(w, w.channelId);
    // The chosen model + a non-empty thinking budget reached the harness as env (what Claude reads).
    expect(text).toContain("sel: model=claude-opus-4-8");
    expect(text).toMatch(/sel: thinking=\d+/);
    expect(text).not.toContain("sel: thinking=none");
  });

  it("Bedrock resolves credentials without baking a secret", async () => {
    const w = await seed();
    const res = await launch(w, { provider: "bedrock", model: "claude-sonnet-4-6" });
    expect(res.statusCode).toBe(202);
    expect(res.json().provider).toBe("bedrock");

    expect((await waitForSession(w, res.json().id)).status).toBe("completed");
    const text = await streamedText(w, w.channelId);
    expect(text).toContain("sel: bedrock=1");
    expect(text).toContain("sel: region=us-east-1");
    expect(text).toContain("sel: apikey=none"); // no API key baked — cloud credential chain supplies creds
  });

  it("Auto mode uses two distinct models in one session", async () => {
    const w = await seed();
    const res = await launch(w, { mode: "auto" });
    expect(res.statusCode).toBe(202);
    expect(res.json().mode).toBe("auto");
    expect(res.json().model).toBe("claude-sonnet-4-6");

    expect((await waitForSession(w, res.json().id)).status).toBe("completed");
    const text = await streamedText(w, w.channelId);
    expect(text).toContain("sel: model=claude-sonnet-4-6"); // implement model
    expect(text).toContain("sel: plan=claude-opus-4-8"); // distinct plan model — two models, one session
  });

  it("refuses a provider outside the tenant allow-list with a 400", async () => {
    const w = await seed();
    const res = await launch(w, { provider: "openai", model: "gpt-x" });
    expect(res.statusCode).toBe(400);
  });

  it("applies the tenant's pinned default model when no selection is requested", async () => {
    // The repo layer pins defaultModel, so a request with no selection still records + runs it.
    const w = await seed();
    const res = await launch(w, {});
    expect(res.statusCode).toBe(202);
    expect(res.json().model).toBe("claude-sonnet-4-6"); // the config default applied
    expect((await waitForSession(w, res.json().id)).status).toBe("completed");
    const text = await streamedText(w, w.channelId);
    expect(text).toContain("sel: model=claude-sonnet-4-6");
  });
});
