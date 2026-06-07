import { describe, it, expect } from "vitest";
import { createRuntime } from "../../src/runtime/factory.js";
import type { SandboxProvider } from "../../src/runtime/sandbox.js";
import type { AgentEnv } from "../../src/env.js";

const baseEnv = (runtime: "local" | "sandbox"): AgentEnv => ({
  runtime,
  harnessCommand: "bash",
  harnessArgs: ["x.sh"],
  caps: { wallClockMs: 1000, idleMs: 500 },
});

// A do-nothing provider — its presence proves the factory wires it without touching Vercel.
const fakeProvider: SandboxProvider = {
  create: () => Promise.reject(new Error("not used")),
};

describe("runtime factory (#25 — backend selected by config, default local)", () => {
  it("defaults to the local backend", () => {
    expect(createRuntime(baseEnv("local")).kind).toBe("local");
  });

  it("selects the sandbox backend and accepts an injected provider (no real Vercel)", () => {
    const rt = createRuntime(baseEnv("sandbox"), fakeProvider);
    expect(rt.kind).toBe("sandbox");
  });
});
