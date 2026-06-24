import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DEFAULTS } from "../../src/config/schema.js";
import { RunProcessManager, type SpawnFn } from "../../src/run/manager.js";

class FakeStream extends EventEmitter {
  destroy = vi.fn();

  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  pid?: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RunProcessManager terminal cleanup (#680)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reclaims terminal run handles after the retention window", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => child as ReturnType<SpawnFn>;
    const manager = new RunProcessManager({
      provisioner: { prepare: async () => ({ cwd: undefined }) },
      loadConfig: () => ({ ...CONFIG_DEFAULTS, run: { command: "pnpm dev" } }),
      spawn,
      terminalRetentionMs: 0,
    });

    await manager.start({ sessionId: "s1", workspaceId: "w1", channelId: "c1" });
    expect(manager.get("s1").status).toBe("starting");

    child.emit("exit", 0);
    expect(manager.get("s1").status).toBe("exited");

    await tick();
    expect(manager.get("s1").status).toBe("idle");
  });

  it("kills active process groups and clears run handles on shutdown (#642)", async () => {
    const child = new FakeChild();
    child.pid = 12345;
    const spawn: SpawnFn = () => child as ReturnType<SpawnFn>;
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const manager = new RunProcessManager({
      provisioner: { prepare: async () => ({ cwd: undefined }) },
      loadConfig: () => ({ ...CONFIG_DEFAULTS, run: { command: "pnpm dev" } }),
      spawn,
    });

    await manager.start({ sessionId: "s1", workspaceId: "w1", channelId: "c1" });
    manager.shutdown();

    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    expect(manager.get("s1").status).toBe("idle");
  });

  it("captures output while running and removes child listeners on exit (#990)", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => child as ReturnType<SpawnFn>;
    const events: unknown[] = [];
    const manager = new RunProcessManager({
      provisioner: { prepare: async () => ({ cwd: undefined }) },
      loadConfig: () => ({ ...CONFIG_DEFAULTS, run: { command: "pnpm dev" } }),
      publish: (_channelId, event) => events.push(event),
      spawn,
    });

    await manager.start({ sessionId: "s1", workspaceId: "w1", channelId: "c1" });
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
    expect(child.listenerCount("exit")).toBe(1);
    expect(child.listenerCount("error")).toBe(1);

    child.stdout.emit("data", "ready http://localhost:5173\n");

    expect(manager.get("s1")).toMatchObject({
      status: "running",
      url: "http://localhost:5173",
      logs: ["ready http://localhost:5173"],
    });
    expect(events).toContainEqual({
      type: "run_log",
      sessionId: "s1",
      channelId: "c1",
      chunk: "ready http://localhost:5173",
    });

    child.emit("exit", 0);

    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(manager.get("s1")).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("removes child listeners immediately when a run is stopped (#990)", async () => {
    const child = new FakeChild();
    child.pid = 12345;
    const spawn: SpawnFn = () => child as ReturnType<SpawnFn>;
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const manager = new RunProcessManager({
      provisioner: { prepare: async () => ({ cwd: undefined }) },
      loadConfig: () => ({ ...CONFIG_DEFAULTS, run: { command: "pnpm dev" } }),
      spawn,
    });

    await manager.start({ sessionId: "s1", workspaceId: "w1", channelId: "c1" });

    expect(manager.stop("s1")).toBe(true);

    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(manager.get("s1").status).toBe("stopped");
  });
});
