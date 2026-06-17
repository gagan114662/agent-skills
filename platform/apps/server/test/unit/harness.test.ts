import { describe, expect, it } from "vitest";
import {
  harnessSpec,
  parseHarnessKind,
  isHarnessKind,
  HARNESS_KINDS,
} from "../../src/runtime/harness.js";

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

  it("redirects the CLI's stdin from /dev/null so the 'no stdin data received in 3s' warning never fires", () => {
    // The runtime spawns the harness with a connected stdin pipe (kept for steering). With nothing
    // written, the claude CLI waits 3s then prints a stderr warning that the runtime captures into the
    // result tail — leaking into every deliverable card. Redirecting the CLI's own stdin to /dev/null
    // makes it see EOF immediately, so the warning is never produced or captured.
    const cmd = harnessSpec("claude-code").args[1];
    expect(cmd).toContain("< /dev/null");
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

describe("harness allowlist (#50 — per-session selection)", () => {
  it("HARNESS_KINDS is the full allowlist and isHarnessKind validates against it", () => {
    expect([...HARNESS_KINDS].sort()).toEqual(["claude-code", "codex", "demo"]);
    expect(isHarnessKind("demo")).toBe(true);
    expect(isHarnessKind("claude-code")).toBe(true);
    expect(isHarnessKind("codex")).toBe(true);
    // Anything outside the union is rejected — the route/manager map this to a 400.
    expect(isHarnessKind("gemini")).toBe(false);
    expect(isHarnessKind("")).toBe(false);
    expect(isHarnessKind("../../bin/sh")).toBe(false);
    expect(isHarnessKind(undefined)).toBe(false);
  });

  it("parseHarnessKind recognizes codex and still defaults unknown/unset to demo", () => {
    expect(parseHarnessKind("codex")).toBe("codex");
    expect(parseHarnessKind("claude-code")).toBe("claude-code");
    expect(parseHarnessKind("nope")).toBe("demo");
    expect(parseHarnessKind(undefined)).toBe("demo");
  });
});

describe("codex harness (#50)", () => {
  it("invokes the real codex CLI in non-interactive json/print mode", () => {
    const spec = harnessSpec("codex");
    expect(spec.command).toBe("bash");
    expect(spec.args[0]).toBe("-lc");
    const cmd = spec.args[1];
    // codex's headless subcommand, the task delivered via the $AGENT_TASK env reference (quoted),
    // JSON event stream so the runtime can render readable channel output, and full-auto so the
    // agent can actually edit files in the session workspace.
    expect(cmd).toContain("'codex' exec \"$AGENT_TASK\"");
    expect(cmd).toContain("--json");
    expect(cmd).toContain("--full-auto");
  });

  it("redirects the CLI's stdin from /dev/null so the empty-pipe stdin warning never fires", () => {
    const cmd = harnessSpec("codex").args[1];
    expect(cmd).toContain("< /dev/null");
  });

  it("honors a custom codex binary path", () => {
    const cmd = harnessSpec("codex", { codexBin: "/opt/bin/codex" }).args[1];
    expect(cmd).toContain("'/opt/bin/codex' exec \"$AGENT_TASK\"");
  });

  it("selects the model via an env-gated --model flag — per-session, never argv", () => {
    const cmd = harnessSpec("codex").args[1];
    // The model is whatever CODEX_MODEL is in the (per-session-merged) env, double-quoted like
    // $AGENT_TASK; when unset the flag vanishes (codex's own default). No static model in argv.
    expect(cmd).toContain('${CODEX_MODEL:+--model "$CODEX_MODEL"}');
  });

  it("injects the task via $AGENT_TASK only — never interpolates task text into argv", () => {
    // Same arity-1 contract as claude-code: the builder takes no task argument, so hostile task
    // content cannot reach the command line.
    expect(harnessSpec).toHaveLength(1);
    const cmd = harnessSpec("codex").args[1];
    expect(cmd).toMatch(/exec "\$AGENT_TASK"/);
  });

  it("never names the OPENAI_API_KEY secret in argv — auth flows via the secrets env path", () => {
    // Auth is OPENAI_API_KEY, injected at provision through the #25 SecretsResolver as runtime env
    // and read by codex natively. It must NEVER appear in the command line (where it could be logged).
    const cmd = harnessSpec("codex").args[1];
    expect(cmd).not.toContain("OPENAI_API_KEY");
  });

  it("appends extra raw flags when provided", () => {
    const cmd = harnessSpec("codex", { codexExtraArgs: ["--cd", "/work"] }).args[1];
    expect(cmd).toContain("'--cd' '/work'");
  });
});
