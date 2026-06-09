import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { FileConfigWorkspaceProvisioner } from "../../src/config/workspace.js";
import type { ResolvedConfig } from "../../src/config/schema.js";

/**
 * Files-to-copy on session create (#58), end-to-end against real Postgres/Redis + LocalRuntime.
 * A repo-scope `filesToCopy` is materialized into the session's working dir; the harness — spawned
 * in that cwd — reads the copied file and prints it, proving the file actually landed where the
 * agent runs. No cloud spend (LocalRuntime), no real Vercel.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const MARKER = "AGENT-CONTEXT-MARKER-9f3a";

// Harness reads the copied file from its cwd (the provisioned session dir) and echoes it.
const READS_CWD_FILE = [
  "-e",
  "const fs=require('fs');" +
    "try{console.log('agent: ctx=' + fs.readFileSync('agent-context.md','utf8').trim());}" +
    "catch(e){console.log('agent: ctx=MISSING');}",
];

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
  const slug = `cfg-${newId()}`;
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

describe("config layering — files-to-copy land in a new session workspace (#58)", () => {
  it("copies the configured file into the session cwd where the harness reads it", async () => {
    // A temp 'repo' with a context file and a workspaceRoot the provisioner writes session dirs into.
    const base = mkdtempSync(join(tmpdir(), "reload-it-cfg-"));
    writeFileSync(join(base, "agent-context.md"), MARKER);
    const workspaceRoot = join(base, "ws");
    const resolved: ResolvedConfig = {
      dataPrivacyMode: false,
      filesToCopy: ["agent-context.md"],
      workspaceRoot,
    };

    const manager = new SessionManager({
      runtime: new LocalRuntime(),
      store: dbStore,
      poster: channelPoster,
      secrets: new StaticSecretsResolver({}),
      harness: { command: process.execPath, args: READS_CWD_FILE },
      caps: { wallClockMs: 20_000, idleMs: 8_000 },
      logger: silentLogger,
      workspace: new FileConfigWorkspaceProvisioner({ baseDir: base, loadConfig: () => resolved }),
    });
    const app = buildApp({ sessionManager: manager });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const w = await seed(app);
    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "read your context" },
    });
    expect(launch.statusCode).toBe(202);
    const sessionId = launch.json().id as string;

    const session = await pollStatus(app, w, sessionId, (s) => s === "completed" || s === "failed");
    expect(session.status).toBe("completed");

    // 1) The file physically landed in the per-session working dir.
    const sessionFile = join(workspaceRoot, sessionId, "agent-context.md");
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(sessionFile, "utf8")).toBe(MARKER);

    // 2) The harness, spawned in that cwd, actually read it — the marker is in the streamed output.
    const messages = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/messages`,
        cookies: { rid: w.cookie },
      })
    ).json() as { body: string }[];
    expect(messages.some((m) => m.body.includes(`agent: ctx=${MARKER}`))).toBe(true);
  });
});
