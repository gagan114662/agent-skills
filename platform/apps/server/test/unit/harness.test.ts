import { describe, expect, it } from "vitest";
import { harnessSpec, parseHarnessKind } from "../../src/runtime/harness.js";

describe("harness selection (#50)", () => {
  it("defaults to the demo harness for unset/unknown values", () => {
    expect(parseHarnessKind(undefined)).toBe("demo");
    expect(parseHarnessKind("nope")).toBe("demo");
    expect(parseHarnessKind("claude-code")).toBe("claude-code");
  });

  it("demo harness preserves the existing bash + demo-script contract", () => {
    const spec = harnessSpec("demo");
    expect(spec.command).toBe("bash");
    expect(spec.args).toEqual(["scripts/agent-harness-demo.sh"]);
  });

  it("claude-code harness invokes the real CLI in print/stream mode", () => {
    const spec = harnessSpec("claude-code");
    expect(spec.command).toBe("bash");
    expect(spec.args[0]).toBe("-lc");
    const cmd = spec.args[1];
    expect(cmd).toContain("'claude' -p \"$AGENT_TASK\"");
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--permission-mode acceptEdits");
  });

  it("honors a custom binary path and model", () => {
    const cmd = harnessSpec("claude-code", {
      claudeBin: "/opt/bin/claude",
      model: "claude-opus-4-8",
    }).args[1];
    expect(cmd).toContain("'/opt/bin/claude' -p \"$AGENT_TASK\"");
    expect(cmd).toContain("--model 'claude-opus-4-8'");
  });

  it("injects the task via $AGENT_TASK only — never interpolates task text into argv", () => {
    // The builder takes no task argument (signature is (kind, opts=) → arity 1), so hostile task
    // content cannot reach the command line.
    expect(harnessSpec).toHaveLength(1);
    const cmd = harnessSpec("claude-code").args[1];
    // The prompt is the env var reference, quoted, not a literal.
    expect(cmd).toMatch(/-p "\$AGENT_TASK"/);
  });

  it("escapes a model value so it cannot break out of the bash -lc string", () => {
    const cmd = harnessSpec("claude-code", { model: "x'; rm -rf /; '" }).args[1];
    expect(cmd).not.toContain("rm -rf / ;");
    expect(cmd).toContain("--model '");
  });
});
