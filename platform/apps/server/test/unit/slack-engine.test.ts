import { describe, it, expect, vi } from "vitest";
import { SlackDigestEngine } from "../../src/slack/engine.js";

/**
 * SlackDigestEngine (#170) — the opt-in daily-digest tick. Default-OFF: a workspace that hasn't enabled
 * `slack.digestEnabled` is skipped; an enabled one gets one DM. Maintenance pauses the whole pass.
 */
const log = { error: () => {}, info: () => {}, warn: () => {} } as never;

describe("SlackDigestEngine (#170 — default OFF)", () => {
  it("skips a workspace that has not opted into the digest", async () => {
    const sendDigest = vi.fn(async () => ({ sent: true }));
    const engine = new SlackDigestEngine({
      listWorkspaceIds: async () => ["ws-1"],
      digestEnabled: () => false,
      maintenancePaused: () => false,
      sendDigest,
      logger: log,
    });
    expect(await engine.tickWorkspace("ws-1")).toEqual({ skipped: true });
    expect(sendDigest).not.toHaveBeenCalled();
  });

  it("sends the digest for an opted-in workspace", async () => {
    const sendDigest = vi.fn(async () => ({ sent: true }));
    const engine = new SlackDigestEngine({
      listWorkspaceIds: async () => ["ws-1"],
      digestEnabled: () => true,
      maintenancePaused: () => false,
      sendDigest,
      logger: log,
    });
    expect(await engine.tickWorkspace("ws-1")).toEqual({ sent: true });
    expect(sendDigest).toHaveBeenCalledWith("ws-1");
  });

  it("pauses the whole pass under maintenance", async () => {
    const sendDigest = vi.fn(async () => ({ sent: true }));
    const engine = new SlackDigestEngine({
      listWorkspaceIds: async () => ["ws-1"],
      digestEnabled: () => true,
      maintenancePaused: () => true,
      sendDigest,
      logger: log,
    });
    await engine.tickAll();
    expect(sendDigest).not.toHaveBeenCalled();
  });

  it("isolates one workspace's failure from the rest of the pass", async () => {
    const sent: string[] = [];
    const engine = new SlackDigestEngine({
      listWorkspaceIds: async () => ["ws-bad", "ws-good"],
      digestEnabled: () => true,
      maintenancePaused: () => false,
      sendDigest: async (wid) => {
        if (wid === "ws-bad") throw new Error("boom");
        sent.push(wid);
        return { sent: true };
      },
      logger: log,
    });
    await engine.tickAll();
    expect(sent).toEqual(["ws-good"]);
  });
});
