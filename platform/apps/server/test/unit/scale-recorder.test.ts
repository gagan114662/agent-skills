import { describe, it, expect } from "vitest";
import { createUsageRecorder } from "../../src/scale/default.js";
import { CONFIG_DEFAULTS, type ResolvedConfig, type ScaleConfig } from "../../src/config/schema.js";
import { EMPTY_USAGE, type UsageSnapshot, type UsageStore } from "../../src/scale/usage.js";

class FakeStore implements UsageStore {
  starts: { workspaceId: string; window: string }[] = [];
  computes: { workspaceId: string; window: string; seconds: number; cost: number }[] = [];
  read(): Promise<UsageSnapshot> {
    return Promise.resolve(EMPTY_USAGE);
  }
  recordStart(workspaceId: string, window: string): Promise<void> {
    this.starts.push({ workspaceId, window });
    return Promise.resolve();
  }
  recordCompute(workspaceId: string, window: string, seconds: number, cost: number): Promise<void> {
    this.computes.push({ workspaceId, window, seconds, cost });
    return Promise.resolve();
  }
}

const cfg = (scale: ScaleConfig): ResolvedConfig => ({ ...CONFIG_DEFAULTS, scale });
const NOW = (): Date => new Date("2026-06-09T00:00:00Z"); // window "2026-06"

describe("createUsageRecorder (#71 — wraps the store with window + rate→cost)", () => {
  it("records a start against the current window", async () => {
    const store = new FakeStore();
    const recorder = createUsageRecorder(store, () => cfg({}), NOW);
    await recorder.recordStart("ws1");
    expect(store.starts).toEqual([{ workspaceId: "ws1", window: "2026-06" }]);
  });

  it("applies the tenant's rate to turn compute-seconds into an estimated cost", async () => {
    const store = new FakeStore();
    const recorder = createUsageRecorder(store, () => cfg({ computeRateCentsPerMinute: 2 }), NOW);
    await recorder.recordCompute("ws1", 90); // 1.5 min @ 2c = 3c
    expect(store.computes).toEqual([{ workspaceId: "ws1", window: "2026-06", seconds: 90, cost: 3 }]);
  });

  it("estimates zero cost when the tenant has no rate configured (budget never bites)", async () => {
    const store = new FakeStore();
    const recorder = createUsageRecorder(store, () => cfg({}), NOW);
    await recorder.recordCompute("ws1", 600);
    expect(store.computes[0]?.cost).toBe(0);
  });
});
