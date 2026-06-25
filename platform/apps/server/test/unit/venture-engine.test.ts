import { afterEach, describe, expect, it, vi } from "vitest";
import { VentureEngine, type VentureEngineDeps } from "../../src/venture/engine.js";
import { VENTURE_DEFAULTS, type VentureCaps } from "../../src/venture/caps.js";

function silentLogger(): VentureEngineDeps["logger"] {
  return {
    error: () => {},
  } as VentureEngineDeps["logger"];
}

function caps(over: Partial<VentureCaps>): VentureCaps {
  return { ...VENTURE_DEFAULTS, ...over };
}

describe("VentureEngine owner-first background tick (#1053)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not tick any workspace when the venture feature flag is off", async () => {
    const ticks: string[] = [];
    const engine = new VentureEngine({
      service: { tick: async (workspaceId: string) => void ticks.push(workspaceId) },
      listActiveEvaluationWorkspaces: async () => ["owner-ws", "customer-ws"],
      caps: () => caps({ enabled: false, ownerWorkspaceOnly: true, ownerWorkspaceId: "owner-ws" }),
      logger: silentLogger(),
    });

    await engine.tickAll();

    expect(ticks).toEqual([]);
  });

  it("ticks only the owner workspace when enabled owner-first", async () => {
    const ticks: string[] = [];
    const engine = new VentureEngine({
      service: { tick: async (workspaceId: string) => void ticks.push(workspaceId) },
      listActiveEvaluationWorkspaces: async () => ["owner-ws", "customer-ws"],
      caps: () =>
        caps({ enabled: true, ownerWorkspaceOnly: true, ownerWorkspaceId: "owner-ws" }),
      logger: silentLogger(),
    });

    await engine.tickAll();

    expect(ticks).toEqual(["owner-ws"]);
  });

  it("start() autonomously ticks the owner workspace on the configured interval", async () => {
    vi.useFakeTimers();
    const ticks: string[] = [];
    const engine = new VentureEngine({
      service: { tick: async (workspaceId: string) => void ticks.push(workspaceId) },
      listActiveEvaluationWorkspaces: async () => ["owner-ws", "customer-ws"],
      caps: () => caps({ enabled: true, ownerWorkspaceOnly: true, ownerWorkspaceId: "owner-ws" }),
      logger: silentLogger(),
    });

    engine.start(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    engine.stop();

    expect(ticks).toEqual(["owner-ws"]);
  });
});
