import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "../../src/config/schema.js";
import { RunProcessManager, type SpawnFn } from "../../src/run/manager.js";

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RunProcessManager terminal cleanup (#680)", () => {
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
});
