import { describe, it, expect, vi } from "vitest";
import { CadenceEngine, type CadenceEngineDeps } from "../../src/cadence/engine.js";
import { resolveCadenceCaps, type CadenceCaps } from "../../src/cadence/caps.js";
import { CADENCE_PLAYBOOK, type CadenceTask } from "../../src/cadence/playbook.js";

const OWNER = "owner-ws";

function silentLogger(): CadenceEngineDeps["logger"] {
  const log: CadenceEngineDeps["logger"] = {
    child: () => log,
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return log;
}

function enabledCaps(over: Partial<CadenceCaps> = {}): CadenceCaps {
  return resolveCadenceCaps({ enabled: true, ownerWorkspaceId: OWNER, ...over });
}

/** Build an engine with an in-memory launch recorder + an injectable clock. */
function makeEngine(opts: {
  caps?: (ws: string) => CadenceCaps;
  launch?: (ws: string, task: CadenceTask) => Promise<void>;
  now?: () => Date;
  ownerWorkspaces?: () => string[];
  outcomes?: CadenceEngineDeps["outcomes"];
} = {}) {
  const launches: Array<{ ws: string; task: CadenceTask }> = [];
  const launch =
    opts.launch ??
    (async (ws: string, task: CadenceTask) => {
      launches.push({ ws, task });
    });
  const engine = new CadenceEngine({
    caps: opts.caps ?? (() => enabledCaps()),
    ownerWorkspaces: opts.ownerWorkspaces ?? (() => [OWNER]),
    launch,
    logger: silentLogger(),
    now: opts.now,
    outcomes: opts.outcomes,
  });
  return { engine, launches };
}

describe("CadenceEngine.tickAll (#416)", () => {
  it("launches exactly ONE task per tick when enabled + under cap", async () => {
    const { engine, launches } = makeEngine();
    await engine.tickAll();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.ws).toBe(OWNER);
    expect(launches[0]!.task).toEqual(CADENCE_PLAYBOOK[0]);
  });

  it("advances the round-robin cursor across ticks (one per tick, in order)", async () => {
    const { engine, launches } = makeEngine({ caps: () => enabledCaps({ maxLaunchesPerDay: 100 }) });
    for (let i = 0; i < CADENCE_PLAYBOOK.length + 1; i++) await engine.tickAll();
    // Visited every task in order, then wrapped back to the first.
    expect(launches.map((l) => l.task)).toEqual([...CADENCE_PLAYBOOK, CADENCE_PLAYBOOK[0]]);
  });

  it("chooses the next task from recorded outcomes instead of fixed round-robin", async () => {
    const { engine, launches } = makeEngine({
      caps: () => enabledCaps({ maxLaunchesPerDay: 5 }),
      outcomes: async () => [{ outcomeKey: "social", result: "worked", conversions: 2 }],
    });
    await engine.tickAll();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.task.lead).toBe("echo");
  });

  it("SKIPS (no launch) when the cadence is disabled for the workspace", async () => {
    const { engine, launches } = makeEngine({ caps: () => resolveCadenceCaps({ enabled: false }) });
    await engine.tickAll();
    expect(launches).toHaveLength(0);
  });

  it("SKIPS a non-owner workspace under owner-first", async () => {
    const { engine, launches } = makeEngine({
      ownerWorkspaces: () => ["customer-ws"],
      caps: () => enabledCaps(), // owner is OWNER, but we tick customer-ws
    });
    await engine.tickAll();
    expect(launches).toHaveLength(0);
  });

  it("enforces the per-day cap: stops launching once the day's count is reached", async () => {
    const { engine, launches } = makeEngine({ caps: () => enabledCaps({ maxLaunchesPerDay: 2 }) });
    await engine.tickAll();
    await engine.tickAll();
    await engine.tickAll(); // over cap → skipped
    await engine.tickAll(); // over cap → skipped
    expect(launches).toHaveLength(2);
  });

  it("a UTC-day rollover (injected clock) RESETS the per-day count", async () => {
    let day = "2026-06-20T08:00:00Z";
    const now = () => new Date(day);
    const { engine, launches } = makeEngine({ caps: () => enabledCaps({ maxLaunchesPerDay: 1 }), now });
    await engine.tickAll(); // day 1: launch
    await engine.tickAll(); // day 1: over cap → skip
    expect(launches).toHaveLength(1);
    day = "2026-06-21T08:00:00Z"; // next UTC day
    await engine.tickAll(); // day 2: count reset → launch again
    expect(launches).toHaveLength(2);
  });

  it("a DENIED launch (throws) does NOT advance the counter or cursor; retried next tick", async () => {
    let calls = 0;
    const launchAttempts: CadenceTask[] = [];
    const { engine } = makeEngine({
      caps: () => enabledCaps({ maxLaunchesPerDay: 5 }),
      launch: async (_ws, task) => {
        launchAttempts.push(task);
        calls += 1;
        if (calls === 1) throw new Error("budget_exceeded"); // first launch denied
      },
    });
    await engine.tickAll(); // denied → no advance
    await engine.tickAll(); // retries the SAME (first) task, now succeeds
    // Both attempts targeted the first task (cursor never advanced on the denial).
    expect(launchAttempts).toEqual([CADENCE_PLAYBOOK[0], CADENCE_PLAYBOOK[0]]);
    // Per-day count only spent on the success → a third tick advances to the second task.
    await engine.tickAll();
    expect(launchAttempts[2]).toEqual(CADENCE_PLAYBOOK[1]);
  });

  it("never throws out of the timer even when launch rejects", async () => {
    const { engine } = makeEngine({
      launch: async () => {
        throw new Error("tenant_capacity");
      },
    });
    await expect(engine.tickAll()).resolves.toBeUndefined();
  });

  it("start() is a no-op for interval <= 0 (default OFF) and stop() is idempotent", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const { engine } = makeEngine();
    engine.start(0); // OFF
    expect(setInterval).not.toHaveBeenCalled();
    engine.stop();
    engine.stop(); // idempotent, no throw
    setInterval.mockRestore();
  });
});
