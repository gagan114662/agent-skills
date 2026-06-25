import { beforeEach, describe, it, expect, vi } from "vitest";
import type { SessionLogger } from "../../src/runtime/manager.js";
import { runBounded } from "../../src/loops/concurrency.js";
import { CadenceEngine, type CadenceEngineDeps } from "../../src/cadence/engine.js";
import { resolveCadenceCaps } from "../../src/cadence/caps.js";
import type { CadenceTask } from "../../src/cadence/playbook.js";
import { AutonomyEngine } from "../../src/autonomy/engine.js";
import { BuildLoopEngine, type BuildLoopEngineDeps } from "../../src/build-loop/engine.js";

const logger: SessionLogger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: vi.fn(),
};

beforeEach(() => {
  vi.mocked(logger.error).mockClear();
});

function delay(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("background loop workspace parallelism (#959)", () => {
  it("runBounded caps in-flight workers", async () => {
    let active = 0;
    let maxActive = 0;
    await runBounded([1, 2, 3, 4, 5], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay();
      active -= 1;
    });
    expect(maxActive).toBe(2);
  });

  it("CadenceEngine launches enabled workspaces concurrently and isolates one rejection", async () => {
    const launches: string[] = [];
    let active = 0;
    let maxActive = 0;
    const deps: CadenceEngineDeps = {
      caps: (workspaceId) => resolveCadenceCaps({ enabled: true, ownerWorkspaceId: workspaceId }),
      ownerWorkspaces: () => ["ws-a", "ws-b", "ws-c"],
      launch: async (workspaceId: string, _task: CadenceTask) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay();
        active -= 1;
        if (workspaceId === "ws-b") throw new Error("workspace denied");
        launches.push(workspaceId);
      },
      logger,
      workspaceConcurrency: 3,
    };

    await new CadenceEngine(deps).tickAll();

    expect(maxActive).toBe(3);
    expect(launches.sort()).toEqual(["ws-a", "ws-c"]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-b" }),
      "cadence tickAll: workspace launch failed (skipped)",
    );
  });

  it("AutonomyEngine tickAll runs workspace ticks concurrently and keeps failures isolated", async () => {
    const engine = new AutonomyEngine({
      poster: { post: vi.fn() },
      logger,
      listActiveWorkspaces: () => Promise.resolve(["ws-a", "ws-b", "ws-c"]),
      workspaceConcurrency: 3,
    });
    const completed: string[] = [];
    let active = 0;
    let maxActive = 0;
    vi.spyOn(engine, "tick").mockImplementation(async (workspaceId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay();
      active -= 1;
      if (workspaceId === "ws-b") throw new Error("boom");
      completed.push(workspaceId);
      return { workspaceId, killSwitch: false, actions: [] };
    });

    await engine.tickAll();

    expect(maxActive).toBe(3);
    expect(completed.sort()).toEqual(["ws-a", "ws-c"]);
  });

  it("BuildLoopEngine tickAll runs workspace ticks concurrently and keeps failures isolated", async () => {
    const deps: BuildLoopEngineDeps = {
      runs: {} as BuildLoopEngineDeps["runs"],
      reviews: {} as BuildLoopEngineDeps["reviews"],
      repo: {} as BuildLoopEngineDeps["repo"],
      launcher: {} as BuildLoopEngineDeps["launcher"],
      reviewer: {} as BuildLoopEngineDeps["reviewer"],
      escalator: {} as BuildLoopEngineDeps["escalator"],
      caps: vi.fn(),
      killSwitch: vi.fn(),
      budgetExhausted: vi.fn(),
      redact: (text: string) => text,
      activeWorkspaces: () => Promise.resolve(["ws-a", "ws-b", "ws-c"]),
      logger,
      workspaceConcurrency: 3,
    };
    const engine = new BuildLoopEngine(deps);
    const completed: string[] = [];
    let active = 0;
    let maxActive = 0;
    vi.spyOn(engine, "tickWorkspace").mockImplementation(async (workspaceId: string, now: Date) => {
      expect(now).toBeInstanceOf(Date);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay();
      active -= 1;
      if (workspaceId === "ws-b") throw new Error("boom");
      completed.push(workspaceId);
      return { workspaceId, ingested: 0, dispatches: [], advances: [] };
    });

    await engine.tickAll();

    expect(maxActive).toBe(3);
    expect(completed.sort()).toEqual(["ws-a", "ws-c"]);
  });
});
