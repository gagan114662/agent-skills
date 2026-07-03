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
    // #1568: the allowlist flag is ALWAYS emitted — persona ceiling verbatim when set, else the
    // read-only research default so a headless session can WebFetch/WebSearch/ToolSearch.
    expect(cmd).toContain('--allowedTools "${AGENT_ALLOWED_TOOLS:-WebFetch,WebSearch,ToolSearch}"');
    // Still a single bash -lc argument — persona config cannot reach the command line literally.
    expect(harnessSpec).toHaveLength(1);
  });

  it("demo harness ignores persona env flags (unchanged contract)", () => {
    const spec = harnessSpec("demo");
    expect(spec.args).toEqual(["scripts/agent-harness-demo.sh"]);
  });
});

describe("fast claude-code turn (#417 — the reload.team speed gap)", () => {
  it("omits --permission-mode acceptEdits (a fast turn cannot apply edits)", () => {
    const cmd = harnessSpec("claude-code", { fast: true }).args[1];
    expect(cmd).not.toContain("--permission-mode acceptEdits");
    expect(cmd).not.toContain("acceptEdits");
  });

  it("forces an empty allowedTools so the model has NO tools (strictly fewer capabilities)", () => {
    const cmd = harnessSpec("claude-code", { fast: true }).args[1];
    // Explicit empty allowlist — no tools to edit/web/spawn. NOT the env-gated AGENT_ALLOWED_TOOLS seam.
    expect(cmd).toContain('--allowedTools ""');
    expect(cmd).not.toContain("$AGENT_ALLOWED_TOOLS");
    expect(cmd).not.toContain("AGENT_SKILLS");
  });

  it("drives the model from ANTHROPIC_FAST_MODEL, not ANTHROPIC_MODEL (cheap model, separate env)", () => {
    const cmd = harnessSpec("claude-code", { fast: true }).args[1];
    expect(cmd).toContain('${ANTHROPIC_FAST_MODEL:+--model "$ANTHROPIC_FAST_MODEL"}');
    expect(cmd).not.toContain("$ANTHROPIC_MODEL");
  });

  it("keeps print mode + stream-json + injection-safe $AGENT_TASK + < /dev/null", () => {
    const cmd = harnessSpec("claude-code", { fast: true }).args[1];
    expect(cmd).toContain("'claude' -p \"$AGENT_TASK\"");
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toMatch(/-p "\$AGENT_TASK"/);
    expect(cmd).toContain("< /dev/null");
    // Still arity-1 (opts-only) — hostile task text can never reach argv.
    expect(harnessSpec).toHaveLength(1);
  });

  it("keeps the persona system-prompt seam but drops the tools seam", () => {
    const cmd = harnessSpec("claude-code", { fast: true }).args[1];
    expect(cmd).toContain(
      '${AGENT_APPEND_SYSTEM_PROMPT:+--append-system-prompt "$AGENT_APPEND_SYSTEM_PROMPT"}',
    );
    expect(cmd).not.toContain("AGENT_ALLOWED_TOOLS");
  });

  it("honors a custom binary path in fast mode", () => {
    const cmd = harnessSpec("claude-code", { fast: true, claudeBin: "/opt/bin/claude" }).args[1];
    expect(cmd).toContain("'/opt/bin/claude' -p \"$AGENT_TASK\"");
  });

  it("fast:false / unset is byte-for-byte the current full spec (snapshot)", () => {
    // The exact current full claude-code command — pinned so a future change to the full spec is caught.
    const FULL =
      `'claude' -p "$AGENT_TASK" ` +
      `--output-format stream-json --verbose --permission-mode acceptEdits ` +
      `\${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"} ` +
      `\${AGENT_APPEND_SYSTEM_PROMPT:+--append-system-prompt "$AGENT_APPEND_SYSTEM_PROMPT"} ` +
      `--allowedTools "\${AGENT_ALLOWED_TOOLS:-WebFetch,WebSearch,ToolSearch}"` +
      ` < /dev/null`;
    expect(harnessSpec("claude-code").args[1]).toBe(FULL);
    expect(harnessSpec("claude-code", { fast: false }).args[1]).toBe(FULL);
    // And the full spec is unchanged by the presence of the fast option.
    expect(harnessSpec("claude-code", {}).args[1]).toBe(FULL);
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
    // JSON event stream so the runtime can render readable channel output, and the supported
    // non-interactive approval/sandbox flags so the agent can actually edit files in the session workspace.
    expect(cmd).toContain("'codex' exec \"$AGENT_TASK\"");
    expect(cmd).toContain("--json");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toContain("--skip-git-repo-check");
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

  it("materializes subscription auth without putting token values in argv", () => {
    // Auth is CODEX_AUTH_JSON, injected through the #25 SecretsResolver as runtime env and written to
    // $CODEX_HOME/auth.json inside the shell. The env var name may appear; its value never does.
    const cmd = harnessSpec("codex").args[1];
    expect(cmd).not.toContain("OPENAI_API_KEY");
    expect(cmd).toContain("CODEX_AUTH_JSON");
    expect(cmd).toContain("auth.json");
  });

  it("appends extra raw flags when provided", () => {
    const cmd = harnessSpec("codex", { codexExtraArgs: ["--cd", "/work"] }).args[1];
    expect(cmd).toContain("'--cd' '/work'");
  });
});
