import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { addChannelMember } from "../../src/db/repositories/channels.js";
import { grantCapability } from "../../src/db/repositories/permissions.js";
import { getRequest } from "../../src/db/repositories/approvals.js";
import { publishTeamEvent } from "../../src/realtime/bus.js";
import { TeamChannel } from "../../src/team/channel.js";
import { TeamCoordinator, type Subtask } from "../../src/team/coordinator.js";
import { buildSubtask, LAUNCH_HANDLES } from "../../src/messaging/inbound-team-launch.js";
import type { TeamArtifactKind, TeamEvent } from "@reload/shared";
import { FREE_TEXT_SCOUT_SENTINEL } from "./fixtures/team-chain-harness.mjs";

/**
 * The WHOLE team-run chain, end to end, on real Postgres + Redis with no cloud and no network:
 *
 *   brief -> coordinator -> subtasks -> claude spawn -> research -> ARTIFACT REGISTERED ->
 *   dependent Quill/Lens/Echo lanes start -> drafts posted -> lens review -> approval-queue entry.
 *
 * The "claude spawn" is a real host child process (the fixture harness) that plays the exact agent
 * contract: it reads the coordinator's injected prompt and emits schema-valid `::team-event::`
 * artifacts the SessionManager posts into the channel. Subtasks come from the REAL production builder
 * (`buildSubtask` — the Telegram/iMessage/web brief path), so the phases, produces/requires wiring,
 * and provider-resolved harness are the shipping ones, not hand-rolled. This is the regression proof
 * that ties #1536 (artifact registration/recovery) and #1568 (no codex spawn under Claude) together:
 * the chain runs green in one pass instead of dead-ending on "missing required artifact".
 */

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const HARNESS = fileURLToPath(new URL("./fixtures/team-chain-harness.mjs", import.meta.url));

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  app: FastifyInstance;
  cookie: string;
  workspaceId: string;
  memberId: string;
  channelId: string;
  coordinator: TeamCoordinator;
  /** agent member ids keyed by launch handle (scout/quill/lens/echo/bid). */
  agents: Record<string, string>;
}

/** Build an app whose TeamCoordinator drives the fixture harness through a real LocalRuntime manager. */
async function startWorld(): Promise<World> {
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    // Provider = claude: the #1568 clamp is active, so a codex-resolved kind can never spawn codex.
    provider: "claude",
    harness: { command: process.execPath, args: [HARNESS] },
    // Every kind (incl. the provider-resolved `claude-code`) resolves to the fixture harness — the
    // deterministic stand-in for the real Claude CLI spawn.
    harnessOverrides: () => ({
      command: process.execPath,
      args: [HARNESS],
      decode: (line) => ({ display: [line], raw: null }),
    }),
    caps: { wallClockMs: 20_000, idleMs: 8_000 },
    logger: silentLogger,
  });
  const channel = new TeamChannel({
    poster: channelPoster,
    publish: (cid, ev) => publishTeamEvent(cid, ev).catch(() => {}),
    listMessages: listChannelMessages,
  });
  const coordinator = new TeamCoordinator({
    launcher: manager,
    channel,
    maxConcurrency: 4,
    logger: silentLogger,
  });
  const app = buildApp({
    sessionManager: manager,
    teamCoordinator: coordinator,
    runtimeProvider: "claude",
  });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  void port; // listening is enough; app.inject drives requests

  const slug = `tc-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channelRes = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "general" },
  });
  const channelId = channelRes.json().id as string;

  // One agent member per launch handle, made a legitimate channel writer (exactly what the team-run
  // route does before launch) so its streamed team events land in the channel.
  const agents: Record<string, string> = {};
  for (const handle of LAUNCH_HANDLES) {
    const agent = await app.inject({
      method: "POST",
      url: `/workspaces/${me.workspaceId}/agents`,
      cookies: { rid: cookie },
      payload: { name: handle },
    });
    const agentMemberId = agent.json().memberId as string;
    agents[handle] = agentMemberId;
    await addChannelMember(channelId, agentMemberId);
    await grantCapability({
      workspaceId: me.workspaceId,
      memberId: agentMemberId,
      resourceType: "channel",
      resourceId: channelId,
      capability: "write",
      grantedByMemberId: me.memberId,
    });
  }

  return { app, cookie, workspaceId: me.workspaceId, memberId: me.memberId, channelId, coordinator, agents };
}

/** The marketing lanes for a brief, built by the shipping brief->subtask builder. */
function marketingSubtasks(w: World, objective: string): Subtask[] {
  return (["scout", "quill", "lens", "echo"] as const).map((handle) =>
    buildSubtask(handle, w.agents[handle]!, objective, "claude"),
  );
}

function artifactKinds(events: TeamEvent[]): TeamArtifactKind[] {
  return events
    .map((e) => e.artifact?.kind)
    .filter((k): k is TeamArtifactKind => !!k);
}

/** subtaskId of the lane that produced a given artifact kind (to map handles to timeline rows). */
function startedSubtaskIds(events: TeamEvent[]): Set<string> {
  return new Set(events.filter((e) => e.kind === "started").map((e) => e.subtaskId));
}

describe("Team-run chain (real Postgres + Redis, LocalRuntime spawn, no cloud)", () => {
  it("walks brief -> spawn -> artifact registered -> dependents start -> drafts -> lens -> approval", async () => {
    const w = await startWorld();
    const teamRunId = newId();
    const subtasks = marketingSubtasks(w, "Launch our weekly analytics digest to small SaaS founders");

    // Sanity: the shipping builder resolves the Claude harness — never codex (#1568).
    expect(subtasks.every((s) => s.preferredHarness === "claude-code")).toBe(true);

    // runTeam awaits every phase to completion — no polling needed.
    const result = await w.coordinator.runTeam({
      workspaceId: w.workspaceId,
      channelId: w.channelId,
      createdByMemberId: w.memberId,
      teamRunId,
      subtasks,
    });

    // Every lane completed; none dead-ended.
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => r.ok)).toBe(true);

    const events = await w.coordinator.readEvents(w.channelId, { limit: 500 });
    const runEvents = events.filter((e) => e.teamRunId === teamRunId);

    // Nothing blocked on a missing upstream artifact — the #1536 dead-end is gone.
    const missingArtifactBlocks = runEvents.filter(
      (e) => e.kind === "blocked" && /missing required artifact/i.test(e.summary),
    );
    expect(missingArtifactBlocks).toEqual([]);

    // Every artifact in the chain was REGISTERED into the channel.
    const kinds = new Set(artifactKinds(runEvents));
    expect(kinds).toEqual(new Set(["scout_research", "brand_voice", "draft_set", "lens_review"]));

    // The dependent lanes actually STARTED (they were not skipped) — all four subtasks ran.
    const started = startedSubtaskIds(runEvents);
    expect(started.size).toBe(4);
    for (const subtask of subtasks) expect(started.has(subtask.subtaskId)).toBe(true);

    // The draft_set carries a channel-native, validator-passing draft (drafts posted).
    const draftSetEvent = runEvents.find((e) => e.artifact?.kind === "draft_set");
    const draftSet = draftSetEvent?.artifact;
    expect(draftSet?.kind).toBe("draft_set");
    if (draftSet?.kind === "draft_set") {
      expect(draftSet.drafts.length).toBeGreaterThan(0);
      expect(draftSet.drafts[0]!.citations.length).toBeGreaterThan(0);
    }

    // The whole run reads as done.
    const timeline = await w.coordinator.timeline(w.channelId, teamRunId);
    expect(timeline.state).toBe("done");
    expect(timeline.counts.done).toBe(4);
    expect(timeline.subtaskCount).toBe(4);

    // Chain terminus: sending a drafted post is PARKED behind a #13 human approval (nothing fires).
    // Same production seam every gated action uses; send/spend gate behavior is untouched here.
    const parked = await w.app.inject({
      method: "POST",
      url: "/me/agent-tools/social.post/invoke",
      cookies: { rid: w.cookie },
      payload: { args: { postId: "weekly-digest-launch", networks: ["x"] } },
    });
    expect(parked.statusCode).toBe(202);
    const parkedBody = parked.json();
    expect(parkedBody.status).toBe("pending_approval");
    expect(typeof parkedBody.approvalRequestId).toBe("string");

    const request = await getRequest(parkedBody.approvalRequestId);
    expect(request?.status).toBe("pending"); // parked only — never auto-approved/executed
    expect(request?.actionType).toBeTruthy();
  });

  it("recovers Scout's artifacts from work product when the lane emits no structured event (#1536)", async () => {
    const w = await startWorld();
    const teamRunId = newId();
    // The sentinel makes the Scout fixture finish its research but emit ONLY narrative output —
    // exactly the live failure where dependents blocked on "missing required artifact: Scout research".
    const subtasks = marketingSubtasks(
      w,
      "Launch our weekly analytics digest to small SaaS founders " + FREE_TEXT_SCOUT_SENTINEL,
    );

    const result = await w.coordinator.runTeam({
      workspaceId: w.workspaceId,
      channelId: w.channelId,
      createdByMemberId: w.memberId,
      teamRunId,
      subtasks,
    });
    expect(result.results.every((r) => r.ok)).toBe(true);

    const runEvents = (await w.coordinator.readEvents(w.channelId, { limit: 500 })).filter(
      (e) => e.teamRunId === teamRunId,
    );

    // Scout's artifacts were RECOVERED from its work product (coordinator-authored fallback), so the
    // chain still completes rather than dead-ending.
    const recovered = runEvents.filter((e) => /recovered .* from lane output/i.test(e.summary));
    expect(new Set(artifactKinds(recovered))).toEqual(new Set(["scout_research", "brand_voice"]));

    // Downstream still produced its real, validator-passing artifacts on top of the recovered ones.
    const kinds = new Set(artifactKinds(runEvents));
    expect(kinds.has("draft_set")).toBe(true);
    expect(kinds.has("lens_review")).toBe(true);

    const missingArtifactBlocks = runEvents.filter(
      (e) => e.kind === "blocked" && /missing required artifact/i.test(e.summary),
    );
    expect(missingArtifactBlocks).toEqual([]);

    const timeline = await w.coordinator.timeline(w.channelId, teamRunId);
    expect(timeline.state).toBe("done");
    expect(timeline.counts.done).toBe(4);
  });

  it("clamps a stale codex harness pick to Claude at the team-run route — never spawns codex (#1568)", async () => {
    const w = await startWorld();
    // An old web bundle / persisted row still asking for codex: under the Claude provider the route
    // remaps it to claude-code, so the preflight that blocks is CLAUDE's — not codex's — proving the
    // codex kind was clamped before any spawn decision.
    const res = await w.app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/team-runs`,
      cookies: { rid: w.cookie },
      payload: {
        subtasks: [{ agentMemberId: w.agents.scout, task: "mine insights", branch: "scout", harness: "codex" }],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("runtime_not_connected");
    expect(body.status.provider).toBe("claude");
    expect(body.status.selectedHarness).toBe("claude-code");
  });
});
