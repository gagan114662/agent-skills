import { describe, it, expect, vi } from "vitest";
import {
  readAllModelOverrideBatches,
  runModelBackfill,
  type ModelBackfillDeps,
} from "../../src/runtime/model-backfill-cli.js";
import { type WorkspaceModelRow } from "../../src/runtime/model-backfill.js";
import { DEFAULT_AGENT_MODEL } from "../../src/runtime/models.js";

/**
 * #293 — the backfill CLI runner. The pure decision is tested in model-backfill.test.ts; here we pin the
 * SAFETY behaviour the premortem (#200) requires: dry-run NEVER writes, apply writes then PROVES the
 * result by reading back (production-grounded receipt), and a write that didn't stick fails closed.
 */
const BAD_ROWS: WorkspaceModelRow[] = [
  { workspaceId: "ws-seo", model: "claude-fable-5" },
  { workspaceId: "ws-ads", model: "gpt-4o" },
  { workspaceId: "ws-ok", model: "claude-sonnet-4-6" },
  { workspaceId: "ws-null", model: null },
];

describe("runModelBackfill (#293 — dry-run by default, apply with read-back receipts)", () => {
  it("reads model overrides in bounded cursor batches", async () => {
    const rows: WorkspaceModelRow[] = Array.from({ length: 1_205 }, (_, i) => ({
      workspaceId: "ws-" + String(i).padStart(4, "0"),
      model: "claude-fable-5",
    }));
    const readBatch = vi.fn(async ({ afterWorkspaceId, limit }: { afterWorkspaceId?: string; limit?: number }) => {
      const start = afterWorkspaceId ? rows.findIndex((row) => row.workspaceId === afterWorkspaceId) + 1 : 0;
      return rows.slice(start, start + (limit ?? 500));
    });

    const all = await readAllModelOverrideBatches(readBatch, 500);

    expect(all).toHaveLength(1_205);
    expect(readBatch).toHaveBeenCalledTimes(3);
    expect(readBatch.mock.calls.map(([arg]) => arg.limit)).toEqual([500, 500, 500]);
    expect(readBatch.mock.calls[1]![0].afterWorkspaceId).toBe("ws-0499");
    expect(readBatch.mock.calls[2]![0].afterWorkspaceId).toBe("ws-0999");
  });

  it("DRY-RUN (default) reports the exact rows it would change and writes NOTHING", async () => {
    const applyChange = vi.fn<ModelBackfillDeps["applyChange"]>(async () => {});
    const report = await runModelBackfill({
      readRows: async () => BAD_ROWS,
      applyChange,
      env: {},
      log: () => {},
    });

    expect(applyChange).not.toHaveBeenCalled(); // THE invariant: a dry-run never touches prod.
    expect(report.applied).toBe(false);
    expect(report.written).toBe(0);
    expect(report.verifiedClean).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.plan.changes).toEqual([
      { workspaceId: "ws-seo", from: "claude-fable-5", to: DEFAULT_AGENT_MODEL },
      { workspaceId: "ws-ads", from: "gpt-4o", to: DEFAULT_AGENT_MODEL },
    ]);
  });

  it("APPLY writes each repair, then reads the rows back and verifies zero unservable remain", async () => {
    // A mutable store that the apply path writes to and the read-back reads from — models the real DB.
    const store = new Map(BAD_ROWS.map((r) => [r.workspaceId, r.model] as const));
    const readRows = vi.fn(async (): Promise<WorkspaceModelRow[]> =>
      [...store].map(([workspaceId, model]) => ({ workspaceId, model })),
    );
    const applyChange = vi.fn(async (workspaceId: string, model: string) => {
      store.set(workspaceId, model);
    });

    const report = await runModelBackfill({ readRows, applyChange, apply: true, env: {}, log: () => {} });

    expect(applyChange).toHaveBeenCalledTimes(2);
    expect(applyChange).toHaveBeenCalledWith("ws-seo", DEFAULT_AGENT_MODEL);
    expect(applyChange).toHaveBeenCalledWith("ws-ads", DEFAULT_AGENT_MODEL);
    expect(readRows).toHaveBeenCalledTimes(2); // initial plan + post-apply read-back receipt.
    expect(report.applied).toBe(true);
    expect(report.written).toBe(2);
    expect(report.verifiedClean).toBe(true);
    expect(report.ok).toBe(true);
    // The valid pick and the null override are preserved, not clobbered.
    expect(store.get("ws-ok")).toBe("claude-sonnet-4-6");
    expect(store.get("ws-null")).toBeNull();
  });

  it("FAILS CLOSED when a write didn't stick — the read-back still shows an unservable override", async () => {
    // A faulty DB whose writes silently no-op: the read-back must catch it instead of reporting success.
    const readRows = async (): Promise<WorkspaceModelRow[]> => [{ workspaceId: "ws-seo", model: "claude-fable-5" }];
    const applyChange = vi.fn(async () => {}); // pretends to write, but readRows never changes.

    const report = await runModelBackfill({ readRows, applyChange, apply: true, env: {}, log: () => {} });

    expect(applyChange).toHaveBeenCalledTimes(1);
    expect(report.applied).toBe(true);
    expect(report.verifiedClean).toBe(false);
    expect(report.ok).toBe(false); // never claims success when reality disagrees (#200).
  });

  it("is a clean no-op when every override is already servable or null (idempotent re-run)", async () => {
    const applyChange = vi.fn(async () => {});
    const report = await runModelBackfill({
      readRows: async () => [
        { workspaceId: "ws-1", model: DEFAULT_AGENT_MODEL },
        { workspaceId: "ws-2", model: null },
      ],
      applyChange,
      apply: true,
      env: {},
      log: () => {},
    });
    expect(applyChange).not.toHaveBeenCalled();
    expect(report.written).toBe(0);
    expect(report.verifiedClean).toBe(true);
    expect(report.ok).toBe(true);
  });
});
