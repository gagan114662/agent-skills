import { describe, it, expect, vi } from "vitest";
import { runMarketingBackfill, type MarketingBackfillDeps } from "../../../src/marketing/backfill.js";

/**
 * #138 boot backfill — pure orchestration that idempotently seeds the department fleet for **existing**
 * workspaces on server boot (signup only covers workspaces created after the fleet was enabled; the
 * owner's workspace predates it). Every IO is an injected seam so this runs in the no-DB unit job.
 *
 * Contract: only seed enabled workspaces that have a human owner; never launch welcome sessions (no
 * spend); be best-effort per workspace (one failure never stops the rest, never throws to crash boot).
 */
function makeDeps(over: Partial<MarketingBackfillDeps> = {}): { deps: MarketingBackfillDeps; seeded: string[] } {
  const seeded: string[] = [];
  const deps: MarketingBackfillDeps = {
    listWorkspaceIds: async () => ["ws-a", "ws-b"],
    ownerMemberId: async (wid) => `owner-${wid}`,
    isEnabled: () => true,
    seed: async ({ workspaceId }) => {
      seeded.push(workspaceId);
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, seeded };
}

describe("#138 runMarketingBackfill", () => {
  it("seeds every enabled workspace that has a human owner", async () => {
    const { deps, seeded } = makeDeps();
    const result = await runMarketingBackfill(deps);
    expect(seeded.sort()).toEqual(["ws-a", "ws-b"]);
    expect(result).toEqual({ seeded: 2, skipped: 0, failed: 0 });
  });

  it("skips workspaces where marketing is not enabled (per-workspace config)", async () => {
    const { deps, seeded } = makeDeps({ isEnabled: (wid) => wid === "ws-a" });
    const result = await runMarketingBackfill(deps);
    expect(seeded).toEqual(["ws-a"]);
    expect(result).toEqual({ seeded: 1, skipped: 1, failed: 0 });
  });

  it("skips a workspace with no human owner (nothing to attribute the seed to)", async () => {
    const { deps, seeded } = makeDeps({ ownerMemberId: async (wid) => (wid === "ws-a" ? "owner-ws-a" : undefined) });
    const result = await runMarketingBackfill(deps);
    expect(seeded).toEqual(["ws-a"]);
    expect(result).toEqual({ seeded: 1, skipped: 1, failed: 0 });
  });

  it("is best-effort: one workspace's failure never stops the others and never throws", async () => {
    const { deps, seeded } = makeDeps({
      listWorkspaceIds: async () => ["ws-a", "ws-bad", "ws-c"],
      seed: async ({ workspaceId }) => {
        if (workspaceId === "ws-bad") throw new Error("boom");
        seeded.push(workspaceId);
      },
    });
    const result = await runMarketingBackfill(deps);
    expect(seeded.sort()).toEqual(["ws-a", "ws-c"]);
    expect(result).toEqual({ seeded: 2, skipped: 0, failed: 1 });
    expect(deps.log.error).toHaveBeenCalledTimes(1);
  });
});
