import { describe, it, expect } from "vitest";
import { SkillOptEngine, type SkillOptEngineDeps } from "../../src/skillopt/engine.js";
import type { SkillOptIdentity, SkillOptRunResult } from "../../src/skillopt/service.js";

const OWNER = "ws-owner";

function silentLogger(): SkillOptEngineDeps["logger"] {
  const log: SkillOptEngineDeps["logger"] = {
    child: () => log,
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return log;
}

function okRun(workspaceId: string): SkillOptRunResult {
  return { workspaceId, enabled: true, agents: [], runId: "run-1" };
}

/** Build an engine with an in-memory run recorder. */
function makeEngine(
  opts: {
    ownerWorkspaces?: () => string[];
    ownerMemberId?: (ws: string) => Promise<string | null>;
    run?: (id: SkillOptIdentity) => Promise<SkillOptRunResult>;
  } = {},
) {
  const runs: SkillOptIdentity[] = [];
  const run =
    opts.run ??
    (async (id: SkillOptIdentity) => {
      runs.push(id);
      return okRun(id.workspaceId);
    });
  const engine = new SkillOptEngine({
    ownerWorkspaces: opts.ownerWorkspaces ?? (() => [OWNER]),
    ownerMemberId: opts.ownerMemberId ?? (() => Promise.resolve("owner-member")),
    run,
    logger: silentLogger(),
  });
  return { engine, runs };
}

describe("skillopt/engine — SkillOptEngine.tickAll", () => {
  it("runs each owner workspace once, attributing the run to the resolved owner member", async () => {
    const { engine, runs } = makeEngine();
    const results = await engine.tickAll();
    expect(runs).toEqual([{ workspaceId: OWNER, requesterMemberId: "owner-member" }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.runId).toBe("run-1");
  });

  it("ticks NOBODY when the owner work-list is empty (default OFF / no owner configured)", async () => {
    const { engine, runs } = makeEngine({ ownerWorkspaces: () => [] });
    const results = await engine.tickAll();
    expect(runs).toHaveLength(0);
    expect(results).toHaveLength(0);
  });

  it("skips a workspace with no owner member (nothing to attribute a #13 proposal to)", async () => {
    const { engine, runs } = makeEngine({ ownerMemberId: () => Promise.resolve(null) });
    const results = await engine.tickAll();
    expect(runs).toHaveLength(0);
    expect(results).toHaveLength(0);
  });

  it("never throws out of the timer: a failing workspace is caught + logged, others still run", async () => {
    const seen: string[] = [];
    const { engine } = makeEngine({
      ownerWorkspaces: () => ["ws-bad", "ws-good"],
      run: async (id) => {
        seen.push(id.workspaceId);
        if (id.workspaceId === "ws-bad") throw new Error("boom");
        return okRun(id.workspaceId);
      },
    });
    const results = await engine.tickAll();
    expect(seen).toEqual(["ws-bad", "ws-good"]); // both attempted
    expect(results).toHaveLength(1); // only the good one yields a result
    expect(results[0]!.workspaceId).toBe("ws-good");
  });

  it("start(0) is a no-op (the loop is opt-in) and stop() is idempotent", () => {
    const { engine } = makeEngine();
    expect(() => engine.start(0)).not.toThrow();
    expect(() => engine.stop()).not.toThrow();
    expect(() => engine.stop()).not.toThrow();
  });
});
