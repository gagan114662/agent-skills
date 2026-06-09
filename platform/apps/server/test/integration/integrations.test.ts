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
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import { formatIssueRef, type IssueContext, type IssueRef } from "../../src/integrations/issues/types.js";
import type { IssueProviders } from "../../src/integrations/issues/registry.js";

/** No-op logger so the manager's internal logging doesn't spam test output. */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// A host harness that echoes AGENT_TASK (so issue/command context is observable in the channel).
const ECHO_HARNESS = [
  "-e",
  "process.stdout.write((process.env.AGENT_TASK || 'none') + '\\n');" +
    "setTimeout(() => process.stdout.write('agent: done\\n'), 20);",
];

const ISSUE_TITLE = "Fix the login bug for special characters";

/** Records provider calls so a test can assert the "act" (link-back comment) happened. */
interface ProviderLog {
  comments: Array<{ ref: IssueRef; body: string }>;
}

function fakeIssueProviders(log: ProviderLog): IssueProviders {
  const make = (source: "github" | "linear") => ({
    source,
    fetchIssue: (ref: IssueRef): Promise<IssueContext> =>
      Promise.resolve({
        source,
        ref: formatIssueRef(ref),
        id: "42",
        title: ISSUE_TITLE,
        body: "Users with p@ss in the password cannot log in.",
        url: "https://example.test/issue/42",
        state: "open",
        labels: ["bug", "auth"],
      }),
    postComment: (ref: IssueRef, _token: string | undefined, body: string): Promise<{ url: string }> => {
      log.comments.push({ ref, body });
      return Promise.resolve({ url: "https://example.test/issue/42#c1" });
    },
  });
  return { github: make("github"), linear: make("linear") };
}

const TEST_CONFIG: ResolvedConfig = {
  ...CONFIG_DEFAULTS,
  slashCommands: {
    echo: { description: "Echo the args back", prompt: "Echo this back: {{args}}" },
  },
  mcpServers: {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_TOKEN"] },
  },
  skills: ["test-driven-development"],
};

const apps: FastifyInstance[] = [];
const slugs: string[] = [];
const providerLog: ProviderLog = { comments: [] };

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

function startApp(): FastifyInstance {
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({ GITHUB_TOKEN: "ghp_test" }),
    harness: { command: process.execPath, args: ECHO_HARNESS },
    caps: { wallClockMs: 20_000, idleMs: 8_000 },
    logger: silentLogger,
  });
  const app = buildApp({
    sessionManager: manager,
    integrations: {
      issueProviders: fakeIssueProviders(providerLog),
      loadConfig: () => TEST_CONFIG,
    },
  });
  apps.push(app);
  return app;
}

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `int-${newId()}`;
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

async function pollStatus(
  app: FastifyInstance,
  w: World,
  sessionId: string,
  until: (s: string) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}`,
      cookies: { rid: w.cookie },
    });
    const body = res.json();
    if (until(body.status)) return body;
    if (Date.now() > deadline) throw new Error(`session stuck in ${body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function channelBodies(app: FastifyInstance, w: World): Promise<string[]> {
  const messages = (
    await app.inject({ method: "GET", url: `/channels/${w.channelId}/messages`, cookies: { rid: w.cookie } })
  ).json() as { body: string }[];
  return messages.map((m) => m.body);
}

describe("deep dev integrations (#57 — real Postgres + Redis, LocalRuntime, no network)", () => {
  it("starts a session from a GitHub issue with the issue context attached", async () => {
    const app = startApp();
    const w = await seed(app);
    const before = providerLog.comments.length;

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/from-issue`,
      cookies: { rid: w.cookie },
      payload: { ref: "github:acme/web#42", agentMemberId: w.agentMemberId, linkBack: true },
    });
    expect(launch.statusCode).toBe(202);
    const out = launch.json();
    expect(out.issue.title).toBe(ISSUE_TITLE);
    expect(out.issue.ref).toBe("github:acme/web#42");

    const session = await pollStatus(app, w, out.id, (s) => s === "completed" || s === "failed");
    expect(session.status).toBe("completed");

    // The issue's title reached the session's task (echoed by the harness into the channel).
    const bodies = await channelBodies(app, w);
    expect(bodies.some((b) => b.includes(ISSUE_TITLE))).toBe(true);

    // The "act": a link-back comment was posted to the issue.
    expect(providerLog.comments.length).toBe(before + 1);
    expect(providerLog.comments.at(-1)!.body).toContain("started for this issue");
  });

  it("rejects a malformed issue ref with 400", async () => {
    const app = startApp();
    const w = await seed(app);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/from-issue`,
      cookies: { rid: w.cookie },
      payload: { ref: "not a real ref", agentMemberId: w.agentMemberId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot start an issue session in another workspace's channel (IDOR)", async () => {
    const app = startApp();
    const a = await seed(app);
    const b = await seed(app);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${a.channelId}/agent-sessions/from-issue`,
      cookies: { rid: b.cookie },
      payload: { ref: "github:acme/web#1", agentMemberId: b.agentMemberId },
    });
    expect(res.statusCode).toBe(404);
  });

  it("runs a project slash command in a session", async () => {
    const app = startApp();
    const w = await seed(app);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/slash`,
      cookies: { rid: w.cookie },
      payload: { command: "/echo hello world", agentMemberId: w.agentMemberId },
    });
    expect(launch.statusCode).toBe(202);
    expect(launch.json().command).toBe("echo");

    const session = await pollStatus(app, w, launch.json().id, (s) => s === "completed" || s === "failed");
    expect(session.status).toBe("completed");

    const bodies = await channelBodies(app, w);
    expect(bodies.some((b) => b.includes("Echo this back: hello world"))).toBe(true);
  });

  it("returns 404 for an unknown slash command", async () => {
    const app = startApp();
    const w = await seed(app);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/slash`,
      cookies: { rid: w.cookie },
      payload: { command: "/does-not-exist", agentMemberId: w.agentMemberId },
    });
    expect(res.statusCode).toBe(404);
  });

  it("exposes the canonical agent-config and syncs it to both harnesses", async () => {
    const app = startApp();
    const w = await seed(app);

    const canonical = await app.inject({
      method: "GET",
      url: "/me/agent-config",
      cookies: { rid: w.cookie },
    });
    expect(canonical.statusCode).toBe(200);
    expect(canonical.json().mcpServers.github).toBeTruthy();
    expect(canonical.json().skills).toContain("test-driven-development");

    const sync = await app.inject({
      method: "POST",
      url: "/me/agent-config/sync",
      cookies: { rid: w.cookie },
      payload: {},
    });
    expect(sync.statusCode).toBe(200);
    const artifacts = sync.json().artifacts as Array<{ harness: string; content: string }>;
    const claude = artifacts.filter((a) => a.harness === "claude-code");
    const codex = artifacts.filter((a) => a.harness === "codex");
    expect(claude.length).toBeGreaterThan(0);
    expect(codex.length).toBeGreaterThan(0);
    // The same MCP server appears in both harnesses' artifacts — and only as a placeholder secret.
    expect(claude.map((a) => a.content).join()).toContain("github");
    expect(codex.map((a) => a.content).join()).toContain("github");
    expect(artifacts.map((a) => a.content).join()).toContain("${GITHUB_TOKEN}");
  });
});
