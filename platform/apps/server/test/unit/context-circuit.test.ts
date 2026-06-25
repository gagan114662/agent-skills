import { describe, expect, it } from "vitest";
import {
  createReasoningLoopGuard,
  estimateContextTokens,
  INTERRUPTED_SYNTHETIC_TURN,
  prepareAgentContext,
  REASONING_LOOP_NUDGE,
} from "../../src/runtime/context-circuit.js";

describe("runtime context circuit (#557)", () => {
  it("compacts older turns when a launch prompt exceeds the token budget", () => {
    const task = [
      "user: old requirement one " + "x".repeat(320),
      "assistant: old plan " + "y".repeat(320),
      "user: current bug report",
      "assistant: latest implementation note",
    ].join("\n");

    const prepared = prepareAgentContext(task, { tokenBudget: 120, keepLastTurns: 2 });

    expect(prepared.compacted).toBe(true);
    expect(prepared.estimatedTokens).toBeLessThanOrEqual(120);
    expect(prepared.task).toContain("Context compacted automatically");
    expect(prepared.task).toContain("Older turn 1");
    expect(prepared.task).toContain("user: current bug report");
    expect(prepared.task).toContain("assistant: latest implementation note");
    expect(prepared.task).not.toContain("x".repeat(80));
  });

  it("adds a synthetic interruption turn before model context", () => {
    const prepared = prepareAgentContext("user: continue", { tokenBudget: 10_000 }, { interrupted: true });

    expect(prepared.compacted).toBe(false);
    expect(prepared.task.startsWith(INTERRUPTED_SYNTHETIC_TURN)).toBe(true);
    expect(prepared.task).toContain("user: continue");
  });

  it("estimates tokens conservatively enough for deterministic budget tests", () => {
    expect(estimateContextTokens("x".repeat(400))).toBe(100);
  });

  it("fires one reasoning-loop nudge after repeated ready-to-act planning signals", () => {
    const guard = createReasoningLoopGuard({ reasoningLoopSignalLimit: 3 });

    expect(guard.observe("I am thinking about the approach.")).toBeNull();
    expect(guard.observe("Let me implement the helper.")).toBeNull();
    expect(guard.observe("Now I will write the tests.")).toBeNull();
    expect(guard.observe("Next, I'll patch the file.")).toBe(REASONING_LOOP_NUDGE);
    expect(guard.observe("I will run another command.")).toBeNull();
  });
});
