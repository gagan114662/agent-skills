import { describe, expect, it, vi } from "vitest";
import { startRetentionLoop, sweepRetention } from "../../src/retention/default.js";

describe("data retention (#679)", () => {
  it("prunes terminal run data older than the configured window and logs the count", async () => {
    const prune = vi.fn(async () => ["s1", "s2"]);
    const logger = { info: vi.fn(), error: vi.fn() };
    const report = await sweepRetention({
      config: { runRetentionDays: 7, intervalMs: 0, batchSize: 100 },
      now: () => new Date("2026-06-23T00:00:00Z"),
      pruneSessions: prune,
      logger,
    });

    expect(prune).toHaveBeenCalledWith(new Date("2026-06-16T00:00:00Z"), 100);
    expect(report).toEqual({ cutoff: new Date("2026-06-16T00:00:00Z"), prunedSessions: 2, disabled: false });
    expect(logger.info).toHaveBeenCalledWith(
      { cutoff: "2026-06-16T00:00:00.000Z", prunedSessions: 2 },
      "data retention pruned old run data",
    );
  });

  it("is configurable-off with a zero-day retention window", async () => {
    const prune = vi.fn(async () => ["s1"]);
    await expect(
      sweepRetention({ config: { runRetentionDays: 0, intervalMs: 1, batchSize: 1 }, pruneSessions: prune }),
    ).resolves.toEqual({ cutoff: null, prunedSessions: 0, disabled: true });
    expect(prune).not.toHaveBeenCalled();
  });

  it("does not start the automatic loop when interval is disabled", () => {
    const sweep = startRetentionLoop({ config: { runRetentionDays: 30, intervalMs: 0, batchSize: 10 } });
    expect(() => sweep.stop()).not.toThrow();
  });
});
