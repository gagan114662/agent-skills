import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLiveSession } from "../../src/db/repositories/agent-sessions.js";
import { createTeamRunStaleSessionReaper } from "../../src/team/stale-session-reaper.js";

const mocks = vi.hoisted(() => ({
  listWorkspaceLiveSessions: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock("../../src/db/repositories/agent-sessions.js", () => ({
  listWorkspaceLiveSessions: mocks.listWorkspaceLiveSessions,
}));

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: mocks.loadConfig,
}));

function liveSession(input: {
  id: string;
  channelId: string;
  progressAt: Date;
}): WorkspaceLiveSession {
  return {
    id: input.id,
    channelId: input.channelId,
    agentMemberId: "ag_" + input.id,
    status: "running",
    agentStatus: "thinking",
    createdAt: input.progressAt,
    startedAt: input.progressAt,
    progressAt: input.progressAt,
  };
}

describe("createTeamRunStaleSessionReaper", () => {
  beforeEach(() => {
    mocks.listWorkspaceLiveSessions.mockReset();
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({ watchdog: { staleCutoffMs: 60_000 } });
  });

  it("cancels only stale live sessions in the submitted channel before a new team run", async () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    mocks.listWorkspaceLiveSessions.mockResolvedValue([
      liveSession({
        id: "stale-scout",
        channelId: "room-1",
        progressAt: new Date("2026-07-02T11:58:30.000Z"),
      }),
      liveSession({
        id: "fresh-quill",
        channelId: "room-1",
        progressAt: new Date("2026-07-02T11:59:30.000Z"),
      }),
      liveSession({
        id: "other-room",
        channelId: "room-2",
        progressAt: new Date("2026-07-02T11:50:00.000Z"),
      }),
    ]);
    const sessionManager = {
      cancel: vi.fn(async () => true),
    };
    const reaper = createTeamRunStaleSessionReaper({
      sessionManager,
      now: () => now,
    });

    const result = await reaper.reap({ workspaceId: "ws_1", channelId: "room-1" });

    expect(mocks.listWorkspaceLiveSessions).toHaveBeenCalledWith("ws_1");
    expect(sessionManager.cancel).toHaveBeenCalledTimes(1);
    expect(sessionManager.cancel).toHaveBeenCalledWith("stale-scout");
    expect(result).toEqual({
      scanned: 2,
      reaped: [{ sessionId: "stale-scout", staleForMs: 90_000, canceled: true }],
    });
  });
});
