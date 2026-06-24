import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalExpiryEngine, type ApprovalExpiryStore } from "../../src/approvals/expiry-engine.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
  logger.info.mockClear();
  logger.error.mockClear();
});

function storeFromCounts(counts: Record<string, number>): ApprovalExpiryStore {
  return {
    async listWorkspaceIds() {
      return Object.keys(counts);
    },
    async sweepExpired(workspaceId) {
      return counts[workspaceId] ?? 0;
    },
  };
}

describe("ApprovalExpiryEngine (#951)", () => {
  it("sweeps expired approvals across all workspaces and reports the total", async () => {
    const engine = new ApprovalExpiryEngine({ store: storeFromCounts({ ws1: 2, ws2: 0, ws3: 1 }), logger });

    await expect(engine.tickAll()).resolves.toEqual({ workspaces: 3, expired: 3 });
    expect(logger.info).toHaveBeenCalledWith(
      { workspaces: 3, expired: 3 },
      "approval expiry sweep expired requests",
    );
  });

  it("continues sweeping other workspaces when one workspace fails", async () => {
    const store: ApprovalExpiryStore = {
      async listWorkspaceIds() {
        return ["bad", "good"];
      },
      async sweepExpired(workspaceId) {
        if (workspaceId === "bad") throw new Error("db hiccup");
        return 1;
      },
    };
    const engine = new ApprovalExpiryEngine({ store, logger });

    await expect(engine.tickAll()).resolves.toEqual({ workspaces: 2, expired: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error), workspaceId: "bad" },
      "approval expiry sweep failed for workspace",
    );
  });

  it("expires a pending request from the background timer within one sweep interval", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-24T04:00:00.000Z");
    const request = {
      status: "pending" as "pending" | "expired",
      expiresAt: new Date(now.getTime() - 1),
    };
    const store: ApprovalExpiryStore = {
      async listWorkspaceIds() {
        return ["ws1"];
      },
      async sweepExpired() {
        if (request.status === "pending" && request.expiresAt.getTime() <= now.getTime()) {
          request.status = "expired";
          return 1;
        }
        return 0;
      },
    };
    const engine = new ApprovalExpiryEngine({ store, logger });

    engine.start(1_000);
    expect(request.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.status).toBe("expired");
    engine.stop();
  });

  it("does not start when the interval is disabled", async () => {
    vi.useFakeTimers();
    const store = storeFromCounts({ ws1: 1 });
    const spy = vi.spyOn(store, "sweepExpired");
    const engine = new ApprovalExpiryEngine({ store, logger });

    engine.start(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();
  });
});
