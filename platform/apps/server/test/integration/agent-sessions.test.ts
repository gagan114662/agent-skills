import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { harnessLineDecoder, type LineDecoder } from "../../src/runtime/stream-json.js";
import { listOpen as listOpenRemediations, selfHealingStore } from "../../src/db/repositories/self-healing.js";
import {
  recordSpawnFailureIncident,
  resolveSpawnFailureIncident,
  AGENT_RUNTIME_SURFACE_KEY,
  SPAWN_INCIDENT_SIGNAL,
} from "../../src/self-healing/spawn-incident.js";
import {
  recordModelFailureIncident,
  resolveModelFailureIncident,
  AGENT_MODEL_SURFACE_KEY,
  MODEL_INCIDENT_SIGNAL,
} from "../../src/self-healing/model-incident.js";
import type { ResourceCaps } from "../../src/db/repositories/agent-sessions.js";
import { createAgentSession, markSessionRunning, getAgentSessionById } from "../../src/db/repositories/agent-sessions.js";
import { createRequest, listRequests } from "../../src/db/repositories/approvals.js";

/** A no-op logger so the manager's internal logging doesn't spam the test output. */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SECRET = "sk-supersecret-value-do-not-leak-123";

// A real (host) harness via node -e: prints the task + a secret line + done, then exits 0.
const COMPLETING_HARNESS = [
  "-e",
  "console.log('agent: task=' + (process.env.AGENT_TASK || 'none'));" +
    "console.log('agent: secret=' + (process.env.MY_SECRET || 'none'));" +
    "setTimeout(() => console.log('agent: done — kept working after the client left'), 50);",
];

// A harness that produces NO output and never exits on its own — to exercise the idle reaper.
const SILENT_HARNESS = ["-e", "setTimeout(() => {}, 60000)"];

// #242: a host harness that reproduces the EXACT prod model-misconfig stream — claude `-p --model
// claude-fable-5` emits one stream-json `result` event with `is_error:true` naming the unavailable model,
// then exits 1 having produced no artifact. Deterministic + spend-free, so it runs in CI.
const MODEL_FAIL_HARNESS = [
  "-e",
  "console.log(JSON.stringify({type:'result',subtype:'success',is_error:true," +
    "result:'There is an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.'}));" +
    "process.exit(1)",
];

// #251: a host harness that exits 0 yet ends its stream-json with a terminal `is_error:true` result —
// the exact "process succeeded, agent run FAILED with no artifact" shape (`claude -p` reporting it's
// missing a tool / hit a cap, then exiting cleanly). Deterministic + spend-free, so it runs in CI.
const ERROR_RESULT_EXIT0_HARNESS = [
  "-e",
  "console.log(JSON.stringify({type:'result',subtype:'error',is_error:true," +
    "result:'I could not complete the task — I am missing a tool I need.'}));" +
    "process.exit(0)",
];

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Build + listen an app whose SessionManager uses LocalRuntime with the given harness/caps. */
async function startApp(
  harnessArgs: string[],
  caps: ResourceCaps,
  command: string = process.execPath, // process.execPath = node
  /** #238/#242: wire the real self-healing incident hooks (open on spawn/model failure, resolve on success). */
  selfHeal = false,
  /** #242: decode harness stdout (claude-code stream-json) so a model-error result becomes a channel line. */
  decode?: LineDecoder,
  /** #248: wire the production deliverable-surfacing sink (completed session → pending review card). */
  surface = false,
): Promise<{
  app: FastifyInstance;
  http: string;
  ws: string;
}> {
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({ MY_SECRET: SECRET }),
    harness: { command, args: harnessArgs },
    caps,
    logger: silentLogger,
    ...(decode ? { decodeOutput: decode } : {}),
    ...(surface
      ? {
          // Mirror production wiring (runtime/default.ts): a clean completion with output surfaces a
          // pending `agent.deliverable` review card so a briefed task never vanishes (#248).
          onSessionCompleted: async (e) => {
            await createRequest({
              workspaceId: e.workspaceId,
              requesterMemberId: e.agentMemberId,
              actionType: "agent.deliverable",
              payload: { sessionId: e.sessionId, channelId: e.channelId, task: e.task, draft: e.result.slice(0, 4000) },
              amount: null,
              summary: `Deliverable ready for review: ${e.task.slice(0, 80)}`,
              status: "pending",
              expiresAt: null,
              events: [{ type: "requested", detail: { sessionId: e.sessionId } }],
            });
          },
        }
      : {}),
    ...(selfHeal
      ? {
          onSessionFailure: async (e) => {
            // #242: a model misconfig opens a DISTINCT self-healing incident (not the spawn surface), and is
            // never routed to the auto-fix flywheel — it's owner-actionable config. Mirrors production wiring.
            if (e.failureClass === "model") {
              await recordModelFailureIncident(selfHealingStore, {
                workspaceId: e.workspaceId,
                detail: `${e.message}${e.errorExcerpt ? ` — ${e.errorExcerpt}` : ""} · exit ${e.exitCode ?? "n/a"}`,
                now: new Date(),
              });
              return;
            }
            if (e.failureClass === "spawn") {
              await recordSpawnFailureIncident(selfHealingStore, {
                workspaceId: e.workspaceId,
                detail: `${e.message} · exit ${e.exitCode ?? "n/a"}`,
                now: new Date(),
              });
            }
          },
          onSessionRecovered: async (e) => {
            await resolveSpawnFailureIncident(selfHealingStore, e.workspaceId, new Date());
            await resolveModelFailureIncident(selfHealingStore, e.workspaceId, new Date());
          },
        }
      : {}),
  });
  const app = buildApp({ sessionManager: manager });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

/** Sign up a human in a fresh workspace, make a channel, register an agent. */
async function seed(app: FastifyInstance): Promise<World> {
  const slug = `as-${newId()}`;
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

/** Poll a session's status until it reaches a terminal state or times out. */
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

describe("cloud agent execution (real Postgres + Redis, LocalRuntime, no cloud)", () => {
  it("runs server-side with the client disconnected and lands the result in the channel", async () => {
    const { app, ws } = await startApp(COMPLETING_HARNESS, { wallClockMs: 20_000, idleMs: 8_000 });
    const w = await seed(app);

    // The launching client connects, subscribes, then DROPS the connection ("closes the laptop").
    const socket = new WebSocket(ws, { headers: { cookie: `rid=${w.cookie}` } });
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    socket.send(JSON.stringify({ type: "subscribe", channelId: w.channelId }));

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "summarize the repo" },
    });
    expect(launch.statusCode).toBe(202);
    const sessionId = launch.json().id as string;

    // Laptop closed: kill the client connection while the agent is still working.
    socket.terminate();

    // The server keeps going. Poll until it finishes.
    const session = await pollStatus(app, w, sessionId, (s) => s === "completed" || s === "failed");
    expect(session.status).toBe("completed");
    expect(session.result).toContain("summarize the repo");

    // The streamed output + result are persisted in the channel even though no client was attached.
    const messages = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/messages`,
        cookies: { rid: w.cookie },
      })
    ).json() as { body: string }[];
    const bodies = messages.map((m) => m.body);
    expect(bodies.some((b) => b.includes("session") && b.includes("started"))).toBe(true);
    expect(bodies.some((b) => b.includes("agent: task=summarize the repo"))).toBe(true);
    expect(bodies.some((b) => b.includes("kept working after the client left"))).toBe(true);
    expect(bodies.some((b) => b.includes("session completed"))).toBe(true);

    // Secret injected at provision is NEVER persisted — redacted in every message + the result.
    const all = bodies.join("\n") + String(session.result);
    expect(all).not.toContain(SECRET);
    expect(bodies.some((b) => b.includes("agent: secret=‹redacted›"))).toBe(true);
  });

  it("renders a failure mark (not a green check) when the harness binary can't be spawned (#166)", async () => {
    // The exact prod incident: the harness command is missing from the image (Alpine had no `bash`),
    // so `spawn` fails with ENOENT, the child never returns an exit code, and the session lands as
    // `failed` with `exitCode: null`. The terminal channel message must NOT lie with a green check.
    const { app } = await startApp([], { wallClockMs: 20_000, idleMs: 8_000 }, "definitely-not-a-real-binary-xyz");
    const w = await seed(app);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "do the thing" },
    });
    expect(launch.statusCode).toBe(202);

    const session = await pollStatus(app, w, launch.json().id, (s) => s === "failed");
    expect(session.status).toBe("failed");

    const bodies = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/messages`,
        cookies: { rid: w.cookie },
      })
    ).json().map((m: { body: string }) => m.body) as string[];

    const terminal = bodies.find((b) => b.includes("session failed"));
    expect(terminal).toBeTruthy();
    // The lying checkmark is gone: a spawn failure shows a failure mark + the reason class, never "✅".
    expect(terminal).not.toContain("✅");
    expect(terminal).toContain("❌");
    expect(terminal!.toLowerCase()).toContain("spawn");
    // No green check anywhere in the thread for this run.
    expect(bodies.some((b) => b.includes("✅"))).toBe(false);
  });

  it("a spawn failure OPENS a self-healing ops incident, and a later success RESOLVES it (#238)", async () => {
    // The #238 gap: 21 spawn failures, yet selfHealingOps read 0 — spawn clusters were never recorded as
    // incidents. With the hooks wired, an un-spawnable harness must open ONE firing incident on the
    // agent-runtime surface (the exact row `listOpen` feeds the founder-console pane from).
    const { app: badApp } = await startApp(
      [],
      { wallClockMs: 20_000, idleMs: 8_000 },
      "definitely-not-a-real-binary-xyz",
      true,
    );
    const w = await seed(badApp);

    // No incident before anything runs.
    expect(await listOpenRemediations(w.workspaceId)).toHaveLength(0);

    const launch = await badApp.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "do the thing" },
    });
    await pollStatus(badApp, w, launch.json().id, (s) => s === "failed");

    // The spawn cluster is now a tracked, deduped self-healing incident (what the console reads).
    const open = await listOpenRemediations(w.workspaceId);
    expect(open).toHaveLength(1);
    expect(open[0]!.surfaceKey).toBe(AGENT_RUNTIME_SURFACE_KEY);
    expect(open[0]!.signal).toBe(SPAWN_INCIDENT_SIGNAL);
    expect(open[0]!.status).toBe("firing");

    // A second spawn failure DEDUPS into the same incident (no second row).
    const launch2 = await badApp.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "again" },
    });
    await pollStatus(badApp, w, launch2.json().id, (s) => s === "failed");
    expect(await listOpenRemediations(w.workspaceId)).toHaveLength(1);

    // Now the runtime "recovers": a real session COMPLETES → the incident resolves itself. Run a
    // completing harness against the SAME workspace's channel (reuse the cookie/channel/agent).
    const { app: goodApp } = await startApp(COMPLETING_HARNESS, { wallClockMs: 20_000, idleMs: 8_000 }, process.execPath, true);
    const launch3 = await goodApp.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "recovered work" },
    });
    await pollStatus(goodApp, w, launch3.json().id, (s) => s === "completed" || s === "failed");
    // The open incident closed once a real session succeeded again (production-grounded recovery proof).
    expect(await listOpenRemediations(w.workspaceId)).toHaveLength(0);
  });

  it("a model misconfig (claude-fable-5) surfaces an actionable reason + opens a self-healing incident, then resolves on recovery (#242)", async () => {
    // The exact prod incident: ANTHROPIC_MODEL=claude-fable-5 made every claude-code session exit 1 having
    // produced nothing, surfacing only an opaque "error · exit 1". With the model class + incident wired, it
    // must now surface an OWNER-ACTIONABLE reason and open a DISTINCT self-healing incident the console reads.
    const { app: badApp } = await startApp(
      MODEL_FAIL_HARNESS,
      { wallClockMs: 20_000, idleMs: 8_000 },
      process.execPath,
      true,
      harnessLineDecoder("claude-code"),
    );
    const w = await seed(badApp);
    expect(await listOpenRemediations(w.workspaceId)).toHaveLength(0);

    const launch = await badApp.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "draft an SEO article with a $49 trial CTA" },
    });
    const session = await pollStatus(badApp, w, launch.json().id, (s) => s === "failed");
    expect(session.status).toBe("failed");
    expect(session.exitCode).toBe(1);

    const bodies = (
      await badApp.inject({ method: "GET", url: `/channels/${w.channelId}/messages`, cookies: { rid: w.cookie } })
    ).json().map((m: { body: string }) => m.body) as string[];
    const terminal = bodies.find((b) => b.includes("session failed"));
    // Not the opaque generic error — an actionable model reason the owner can act on.
    expect(terminal).toContain("❌");
    expect(terminal).toContain("Settings → Model");
    expect(bodies.some((b) => b.includes("✅"))).toBe(false);
    // The real cause is in the thread (the decoded model error), proving "the details are in the thread".
    expect(bodies.some((b) => b.toLowerCase().includes("selected model"))).toBe(true);

    // The failure is now a tracked self-healing incident on the DISTINCT agent-model surface (NOT spawn).
    const open = await listOpenRemediations(w.workspaceId);
    expect(open).toHaveLength(1);
    expect(open[0]!.surfaceKey).toBe(AGENT_MODEL_SURFACE_KEY);
    expect(open[0]!.signal).toBe(MODEL_INCIDENT_SIGNAL);
    expect(open[0]!.detail).toContain("claude-fable-5"); // names the actual unavailable model

    // A retry on a VALID model (the fix) COMPLETES and resolves the incident — the self-heal loop.
    const { app: goodApp } = await startApp(
      COMPLETING_HARNESS,
      { wallClockMs: 20_000, idleMs: 8_000 },
      process.execPath,
      true,
    );
    const retry = await goodApp.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "draft an SEO article with a $49 trial CTA" },
    });
    const ok = await pollStatus(goodApp, w, retry.json().id, (s) => s === "completed" || s === "failed");
    expect(ok.status).toBe("completed");
    expect(await listOpenRemediations(w.workspaceId)).toHaveLength(0);
  });

  it("reaps an idle session to idle_reaped and enforces the cap", async () => {
    const { app } = await startApp(SILENT_HARNESS, { wallClockMs: 30_000, idleMs: 400 });
    const w = await seed(app);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "sleep forever" },
    });
    expect(launch.statusCode).toBe(202);

    const session = await pollStatus(app, w, launch.json().id, (s) => s === "idle_reaped");
    expect(session.status).toBe("idle_reaped");
    expect(session.endedAt).toBeTruthy();
  });

  it("a completed task SURFACES its draft as a pending review card — never vanishes (#248)", async () => {
    // The prod bug: an @mention-briefed session completed with a real draft in agent_sessions.result +
    // a channel post, but created NO approval_request → it "vanished" from the board. With the
    // deliverable sink wired, a clean completion lands a pending `agent.deliverable` review card.
    const { app } = await startApp(
      COMPLETING_HARNESS,
      { wallClockMs: 20_000, idleMs: 8_000 },
      process.execPath,
      false,
      undefined,
      true, // surface deliverables
    );
    const w = await seed(app);
    expect(await listRequests(w.workspaceId, { status: "pending" })).toHaveLength(0);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "draft 3 tweets" },
    });
    const session = await pollStatus(app, w, launch.json().id, (s) => s === "completed" || s === "failed");
    expect(session.status).toBe("completed");

    // Poll the queue: the deliverable card is created best-effort just after finalize.
    let pending: Awaited<ReturnType<typeof listRequests>> = [];
    const deadline = Date.now() + 5_000;
    for (;;) {
      pending = await listRequests(w.workspaceId, { status: "pending" });
      if (pending.length > 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]!.actionType).toBe("agent.deliverable");
    expect(pending[0]!.amount).toBeNull(); // NOT a money action (#243 intact)
    expect(pending[0]!.summary).toContain("draft 3 tweets");
    expect((pending[0]!.payload as { sessionId: string }).sessionId).toBe(launch.json().id);
  });

  it("a run that exits 0 but reports an error NEVER surfaces a deliverable card — it lands Failed (#251)", async () => {
    // The prod bug: `claude -p` exited 0 yet ended its stream with `{type:'result', is_error:true}`. The
    // process succeeded, so the run was finalized `completed` and surfaced a "Deliverable ready for
    // review" approval card with an Approve button — but the only "content" was the agent's error. With
    // the fix, that run is reconciled to `failed`: no card, a failure mark in the channel, no green check.
    const { app } = await startApp(
      ERROR_RESULT_EXIT0_HARNESS,
      { wallClockMs: 20_000, idleMs: 8_000 },
      process.execPath,
      false,
      harnessLineDecoder("claude-code"), // decode the stream-json result so is_error is seen
      true, // surface deliverables (the sink that wrongly fired before the fix)
    );
    const w = await seed(app);
    expect(await listRequests(w.workspaceId, { status: "pending" })).toHaveLength(0);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "draft 3 tweets" },
    });
    // The run is reconciled to failed (not "completed") despite the clean exit 0.
    const session = await pollStatus(app, w, launch.json().id, (s) => s === "completed" || s === "failed");
    expect(session.status).toBe("failed");

    // The terminal channel message is a failure mark + reason, never the lying green check.
    const messages = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/messages`,
      cookies: { rid: w.cookie },
    });
    const bodies = (messages.json() as { body: string }[]).map((m) => m.body);
    const terminal = bodies.find((b) => b.includes("session failed"));
    expect(terminal).toBeTruthy();
    expect(bodies.some((b) => b.includes("✅"))).toBe(false);

    // And NO deliverable / approval card was created (never an Approve button on a no-artifact run).
    await new Promise((r) => setTimeout(r, 300)); // a card would be created best-effort just after finalize
    const pending = await listRequests(w.workspaceId, { status: "pending" });
    expect(pending.filter((r) => r.actionType === "agent.deliverable")).toHaveLength(0);
  });

  it("the owner can STOP an orphaned/stuck running session — it reaches a terminal state (#248)", async () => {
    // The 30-min stuck Scout: a `running` row this process is not driving (orphaned by a deploy). The
    // existing cancel returned false for it. The robust cancel force-finalizes the durable row.
    const { app } = await startApp(COMPLETING_HARNESS, { wallClockMs: 20_000, idleMs: 8_000 });
    const w = await seed(app);

    // Simulate an orphaned live row directly (no in-memory runner attached to THIS manager).
    const orphan = await createAgentSession({
      workspaceId: w.workspaceId,
      channelId: w.channelId,
      agentMemberId: w.agentMemberId,
      createdByMemberId: null,
      runtime: "local",
      command: "node",
      caps: { wallClockMs: 20_000, idleMs: 8_000 },
    });
    await markSessionRunning(orphan.id);
    expect((await getAgentSessionById(orphan.id))?.status).toBe("running");

    // The owner stops it from the board (mission-control stop → robust cancel).
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/mission-control/sessions/${orphan.id}/stop`,
      cookies: { rid: w.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canceled).toBe(true);

    const after = await getAgentSessionById(orphan.id);
    expect(after?.status).toBe("canceled");
    expect(after?.endedAt).toBeTruthy();
    expect(after?.result).toContain("Canceled by the owner");
  });

  it("a workspace cannot launch a session into another workspace's channel (IDOR)", async () => {
    const { app } = await startApp(COMPLETING_HARNESS, { wallClockMs: 20_000, idleMs: 8_000 });
    const a = await seed(app);
    const b = await seed(app); // different workspace + cookie

    const res = await app.inject({
      method: "POST",
      url: `/channels/${a.channelId}/agent-sessions`, // A's channel
      cookies: { rid: b.cookie }, // B's identity
      payload: { agentMemberId: b.agentMemberId, task: "intrude" },
    });
    expect(res.statusCode).toBe(404); // cross-workspace channel is invisible
  });
});
