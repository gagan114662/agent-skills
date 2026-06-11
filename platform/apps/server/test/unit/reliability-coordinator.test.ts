import { describe, it, expect, vi } from "vitest";
import {
  IncidentCoordinator,
  type IncidentCoordinatorDeps,
} from "../../src/reliability/coordinator.js";
import { resolveReliabilityCaps } from "../../src/reliability/caps.js";
import type { IncidentRecord } from "../../src/sre/types.js";

const silentLogger = { child: () => silentLogger, info: () => {}, warn: () => {}, error: () => {} } as const;
const NOW = new Date("2026-06-11T12:00:00Z");

function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: "inc-1",
    workspaceId: "ws-1",
    service: "api",
    sloKind: "availability",
    severity: "critical",
    status: "firing",
    observedValue: 0.4,
    targetValue: 0.99,
    budgetRemaining: 0,
    triageSessionId: null,
    postmortemPath: null,
    openedAt: NOW,
    lastNotifiedAt: NOW,
    resolvedAt: null,
    ...overrides,
  };
}

function makeCoordinator(overrides: Partial<IncidentCoordinatorDeps> = {}, enabled = true) {
  const posts: Array<{ channelId: string; body: string }> = [];
  const overlay = { id: "ov-1", workspaceId: "ws-1", incidentId: "inc-1", seq: 1, channelId: null as string | null, investigationNote: null as string | null, lastPagedAt: null as Date | null, ackedAt: null as Date | null, pageCount: 0 };
  const fallbackNotify = vi.fn(async () => {});
  const deps: IncidentCoordinatorDeps = {
    caps: () => resolveReliabilityCaps({ enabled }),
    fallback: { notify: fallbackNotify },
    overlay: {
      ensure: vi.fn(async () => overlay),
      setChannel: vi.fn(async (_id, channelId) => void (overlay.channelId = channelId)),
      setNote: vi.fn(async (_id, note) => void (overlay.investigationNote = note)),
      recordPaged: vi.fn(async () => void (overlay.pageCount += 1)),
    },
    channels: {
      create: vi.fn(async () => ({ id: "chan-incident" })),
      post: vi.fn(async (input) => void posts.push({ channelId: input.channelId, body: input.body })),
      poster: vi.fn(async () => ({ agentMemberId: "agent-1" })),
    },
    investigation: {
      gather: vi.fn(async () => ({
        recentDeploys: [{ id: "dep-1", target: "fly", status: "ready", at: new Date("2026-06-11T11:55:00Z") }],
        fingerprints: [],
        saturation: { status: "ok" as const },
      })),
    },
    pager: { page: vi.fn(async () => ({ delivered: true, reason: "opened" })) },
    logger: silentLogger,
    now: () => NOW,
    ...overrides,
  };
  return { coord: new IncidentCoordinator(deps), deps, posts, overlay, fallbackNotify };
}

describe("IncidentCoordinator — disabled (default) delegates to the #112 behavior", () => {
  it("posts via the fallback notifier and never creates a channel or pages", async () => {
    const { coord, deps, fallbackNotify } = makeCoordinator({}, false);
    await coord.notify({ workspaceId: "ws-1", incident: incident(), kind: "opened" });
    expect(fallbackNotify).toHaveBeenCalledWith(expect.objectContaining({ kind: "opened" }));
    expect(deps.channels.create).not.toHaveBeenCalled();
    expect(deps.pager.page).not.toHaveBeenCalled();
  });
});

describe("IncidentCoordinator — opened", () => {
  it("creates the #incident-NNN war-room, posts the timeline + investigation note, stores it, and pages", async () => {
    const { coord, deps, posts, overlay } = makeCoordinator();
    await coord.notify({ workspaceId: "ws-1", incident: incident(), kind: "opened" });

    expect(deps.overlay.ensure).toHaveBeenCalledWith("ws-1", "inc-1");
    expect(deps.channels.create).toHaveBeenCalledWith("ws-1", "incident-001");
    expect(deps.overlay.setChannel).toHaveBeenCalledWith("ov-1", "chan-incident");

    // detected message + investigation note both posted to the war-room
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[0].body.toLowerCase()).toContain("detected");
    expect(posts.some((p) => p.body.includes("AI investigation"))).toBe(true);
    expect(posts.some((p) => p.body.includes("dep-1"))).toBe(true); // correlated the recent deploy

    // note stored on the overlay
    expect(deps.overlay.setNote).toHaveBeenCalledWith("ov-1", expect.stringContaining("AI investigation"));
    expect(overlay.investigationNote).toContain("AI investigation");

    // owner paged
    expect(deps.pager.page).toHaveBeenCalledWith(expect.objectContaining({ kind: "opened", severity: "critical", incidentId: "inc-1" }));
    expect(deps.overlay.recordPaged).toHaveBeenCalled(); // delivered → bump
  });

  it("still pages even when there is no agent to post the war-room timeline", async () => {
    const { coord, deps, posts } = makeCoordinator({
      channels: {
        create: vi.fn(async () => ({ id: "c" })),
        post: vi.fn(),
        poster: vi.fn(async () => null), // no live agent member
      },
    });
    await coord.notify({ workspaceId: "ws-1", incident: incident(), kind: "opened" });
    expect(posts).toHaveLength(0); // no war-room posts
    expect(deps.pager.page).toHaveBeenCalled(); // but the owner is still paged
  });

  it("does not bump the page count when the pager suppresses the page", async () => {
    const { coord, deps } = makeCoordinator({
      pager: { page: vi.fn(async () => ({ delivered: false, reason: "rate_limited" })) },
    });
    await coord.notify({ workspaceId: "ws-1", incident: incident(), kind: "opened" });
    expect(deps.overlay.recordPaged).not.toHaveBeenCalled();
  });
});

describe("IncidentCoordinator — repaged / resolved", () => {
  it("repaged posts a still-firing line to the existing war-room and re-pages with overlay state", async () => {
    const { coord, deps, posts } = makeCoordinator();
    deps.overlay.ensure = vi.fn(async () => ({
      id: "ov-1", workspaceId: "ws-1", incidentId: "inc-1", seq: 1,
      channelId: "chan-incident", investigationNote: "x",
      lastPagedAt: new Date("2026-06-11T11:40:00Z"), ackedAt: null, pageCount: 1,
    }));
    await coord.notify({ workspaceId: "ws-1", incident: incident(), kind: "repaged" });
    expect(posts.some((p) => p.body.toLowerCase().includes("still"))).toBe(true);
    expect(deps.pager.page).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "repaged", lastPagedAt: new Date("2026-06-11T11:40:00Z"), ackedAt: null }),
    );
  });

  it("resolved posts the postmortem summary to the war-room and sends a closure page", async () => {
    const { coord, deps, posts } = makeCoordinator();
    deps.overlay.ensure = vi.fn(async () => ({
      id: "ov-1", workspaceId: "ws-1", incidentId: "inc-1", seq: 1,
      channelId: "chan-incident", investigationNote: "x", lastPagedAt: null, ackedAt: null, pageCount: 0,
    }));
    await coord.notify({
      workspaceId: "ws-1",
      incident: incident({ status: "resolved", postmortemPath: "docs/postmortems/2026-06-11-api.md", resolvedAt: NOW }),
      kind: "resolved",
    });
    expect(posts.some((p) => p.body.includes("docs/postmortems/2026-06-11-api.md"))).toBe(true);
    expect(deps.pager.page).toHaveBeenCalledWith(expect.objectContaining({ kind: "resolved" }));
  });
});
