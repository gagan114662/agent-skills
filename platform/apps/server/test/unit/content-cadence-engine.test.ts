import { describe, it, expect, vi } from "vitest";
import { ContentCadenceEngine, type ContentCadenceEngineDeps } from "../../src/marketing/content-cadence/engine.js";
import type { ContentCadenceConfigInput } from "../../src/marketing/content-cadence/decide.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ContentCadenceEngineDeps["logger"];

function makeEngine(overrides: Partial<ContentCadenceEngineDeps> = {}) {
  const brief = overrides.brief ?? vi.fn(async () => ({ ok: true }));
  const config: ContentCadenceConfigInput = {
    enabled: true,
    ownerWorkspaceOnly: false,
    queries: ["alpha query", "beta query"],
  };
  const deps: ContentCadenceEngineDeps = {
    config: () => config,
    listWorkspaceIds: async () => ["ws-1"],
    resolveOwnerMemberId: async () => "owner-member",
    brief,
    logger: silentLogger,
    ...overrides,
  };
  return { engine: new ContentCadenceEngine(deps), brief };
}

const DAY0 = new Date("2026-06-20T09:00:00Z");
const DAY1 = new Date("2026-06-21T09:00:00Z");

describe("ContentCadenceEngine (#416)", () => {
  it("does nothing when the cadence is disabled (default-OFF prod)", async () => {
    const { engine, brief } = makeEngine({ config: () => ({ enabled: false, queries: ["a"] }) });
    const r = await engine.tickWorkspace("ws-1", DAY0);
    expect(r).toEqual({ workspaceId: "ws-1", briefed: null, reason: "disabled" });
    expect(brief).not.toHaveBeenCalled();
  });

  it("briefs the next content objective through the audited brief path with systemAuthorized", async () => {
    const { engine, brief } = makeEngine();
    const r = await engine.tickWorkspace("ws-1", DAY0);
    expect(r.reason).toBe("briefed");
    expect(brief).toHaveBeenCalledTimes(1);
    const [identity, input] = (brief as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(identity).toEqual({ workspaceId: "ws-1", memberId: "owner-member" });
    expect(input.lead).toBe("scout"); // #359: Scout leads (research), hands off to Quill
    expect(input.systemAuthorized).toBe(true);
    expect(input.goal.toLowerCase()).toContain("publish");
  });

  it("is a no-op on a second tick the same day (watermark)", async () => {
    const { engine, brief } = makeEngine();
    await engine.tickWorkspace("ws-1", DAY0);
    const r = await engine.tickWorkspace("ws-1", new Date("2026-06-20T18:00:00Z"));
    expect(r.reason).toBe("already-briefed-today");
    expect(brief).toHaveBeenCalledTimes(1);
  });

  it("rotates to the next query on the next day", async () => {
    const { engine, brief } = makeEngine();
    await engine.tickWorkspace("ws-1", DAY0);
    await engine.tickWorkspace("ws-1", DAY1);
    const calls = (brief as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].goal).toContain("alpha query");
    expect(calls[1][1].goal).toContain("beta query");
  });

  it("skips when there is no owner member to post as", async () => {
    const { engine, brief } = makeEngine({ resolveOwnerMemberId: async () => undefined });
    const r = await engine.tickWorkspace("ws-1", DAY0);
    expect(r.reason).toBe("no-owner");
    expect(brief).not.toHaveBeenCalled();
  });

  it("claims the day even when the launch FAILS, so it never re-spams the same day", async () => {
    const brief = vi.fn(async () => ({ ok: false, code: 429, error: "budget" }));
    const { engine } = makeEngine({ brief });
    const r1 = await engine.tickWorkspace("ws-1", DAY0);
    expect(r1.reason).toBe("launch-failed");
    const r2 = await engine.tickWorkspace("ws-1", new Date("2026-06-20T20:00:00Z"));
    expect(r2.reason).toBe("already-briefed-today");
    expect(brief).toHaveBeenCalledTimes(1); // exactly once — no retry storm
  });

  it("tickAll skips the whole pass under maintenance", async () => {
    const brief = vi.fn(async () => ({ ok: true }));
    const { engine } = makeEngine({ brief, maintenancePaused: async () => true });
    await engine.tickAll();
    expect(brief).not.toHaveBeenCalled();
  });
});
