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

  it("honors a custom binary path", () => {
    const cmd = harnessSpec("claude-code", { claudeBin: "/opt/bin/claude" }).args[1];
    expect(cmd).toContain("'/opt/bin/claude' -p \"$AGENT_TASK\"");
  });

  it("selects the model via an env-gated --model flag (#52) — per-session, never argv", () => {
    const cmd = harnessSpec("claude-code").args[1];
    // The model is whatever ANTHROPIC_MODEL is in the (per-session-merged) env, double-quoted like
    // $AGENT_TASK; when unset the flag vanishes (Claude Code's own default). No static model in argv.
    expect(cmd).toContain('${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}');
    expect(harnessSpec).toHaveLength(1);
  });

  it("injects the task via $AGENT_TASK only — never interpolates task text into argv", () => {
    // The builder takes no task argument (signature is (kind, opts=) → arity 1), so hostile task
    // content cannot reach the command line.
    expect(harnessSpec).toHaveLength(1);
    const cmd = harnessSpec("claude-code").args[1];
    // The prompt is the env var reference, quoted, not a literal.
    expect(cmd).toMatch(/-p "\$AGENT_TASK"/);
  });

  it("never interpolates a model value into argv — selection is env-driven (#52)", () => {
    // There is no `model` option any more: a hostile model string cannot reach the command line
    // because the flag references the $ANTHROPIC_MODEL env var, never a baked literal.
    const cmd = harnessSpec("claude-code").args[1];
    expect(cmd).not.toMatch(/--model '/); // no single-quoted literal model in the command
    expect(cmd).toContain('--model "$ANTHROPIC_MODEL"');
  });

  it("threads persona prompt + tools via env-gated flags only (#59) — never argv", () => {
    const cmd = harnessSpec("claude-code").args[1];
    // The persona system prompt is appended only when AGENT_APPEND_SYSTEM_PROMPT is set, via bash
    // ${VAR:+...} expansion of a double-quoted env reference (injection-safe like $AGENT_TASK).
    expect(cmd).toContain('${AGENT_APPEND_SYSTEM_PROMPT:+--append-system-prompt "$AGENT_APPEND_SYSTEM_PROMPT"}');
    // The allowed-tools ceiling is passed only when AGENT_ALLOWED_TOOLS is set.
    expect(cmd).toContain('${AGENT_ALLOWED_TOOLS:+--allowedTools "$AGENT_ALLOWED_TOOLS"}');
    // Still a single bash -lc argument — persona config cannot reach the command line literally.
    expect(harnessSpec).toHaveLength(1);
  });

  it("demo harness ignores persona env flags (unchanged contract)", () => {
    const spec = harnessSpec("demo");
    expect(spec.args).toEqual(["scripts/agent-harness-demo.sh"]);
  });
});
