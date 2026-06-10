/**
 * Agent harness selection (#50).
 *
 * A "harness" is the trusted command the runtime spawns for each agent session — the thing that
 * actually does the coding. It is NEVER client-supplied. The task/prompt is injected at runtime via
 * the `AGENT_TASK` environment variable (the same contract the demo harness already uses), so
 * untrusted task text is never interpolated into argv and cannot break out into the command line.
 *
 * Backends:
 *   - `demo` (default): a tiny script that echoes the task. Dev/CI only — no model spend.
 *   - `claude-code`: the real Claude Code CLI in non-interactive print mode against the task,
 *     streaming output back through the runtime. Requires the `claude` binary + auth in the
 *     execution environment (the host for LocalRuntime, the image for SandboxRuntime).
 *
 * The spec returned here plugs straight into the existing `{ command, args }` contract consumed by
 * `SessionManager`/`AgentRuntime`, so selecting a harness changes no other code path.
 */
export type HarnessKind = "demo" | "claude-code";

export interface HarnessSpec {
  command: string;
  args: string[];
}

export interface HarnessOptions {
  /** Path or name of the Claude Code binary. Default `claude`. */
  claudeBin?: string;
  /** Extra raw flags appended to the claude invocation. */
  claudeExtraArgs?: string[];
}

const DEMO: HarnessSpec = { command: "bash", args: ["scripts/agent-harness-demo.sh"] };

export function parseHarnessKind(value: string | undefined): HarnessKind {
  return value === "claude-code" ? "claude-code" : "demo";
}

/**
 * Build the trusted command/args for a harness. Does NOT take the task — the task is supplied at
 * run time as the `AGENT_TASK` env var, so this is pure and injection-safe by construction.
 */
export function harnessSpec(kind: HarnessKind, opts: HarnessOptions = {}): HarnessSpec {
  if (kind === "demo") return { command: DEMO.command, args: [...DEMO.args] };

  const bin = opts.claudeBin ?? "claude";
  const extra =
    opts.claudeExtraArgs && opts.claudeExtraArgs.length > 0
      ? " " + opts.claudeExtraArgs.map(shellQuote).join(" ")
      : "";

  // Print mode + JSON stream so the runtime can surface turns/tool-calls; acceptEdits so the agent
  // can actually modify files in the session workspace. `"$AGENT_TASK"` is double-quoted and is NOT
  // re-evaluated by bash (no command substitution on a variable's value), so task text — even if
  // hostile — cannot inject shell.
  //
  // Subagent personas (#59) thread their system prompt + allowed-tools ceiling the SAME way — as env,
  // never argv — using bash `${VAR:+word}` expansion: the flag appears only when the var is set and
  // non-empty, and the value is a double-quoted env reference (injection-safe like $AGENT_TASK).
  // Non-persona sessions leave these unset, so the flags vanish and behavior is unchanged.
  const persona =
    ` ` +
    `\${AGENT_APPEND_SYSTEM_PROMPT:+--append-system-prompt "$AGENT_APPEND_SYSTEM_PROMPT"}` +
    ` ` +
    `\${AGENT_ALLOWED_TOOLS:+--allowedTools "$AGENT_ALLOWED_TOOLS"}`;
  // Model + provider selection (#52) reaches Claude Code via env it reads natively (ANTHROPIC_MODEL,
  // ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK/VERTEX, MAX_THINKING_TOKENS, ANTHROPIC_DEFAULT_OPUS_MODEL),
  // so per-session selection is the same injection-safe env seam as the task/persona — never argv. The
  // model is surfaced as an env-gated `--model` flag (double-quoted env reference, like `$AGENT_TASK`)
  // so the chosen model is explicit/overridable per session; when ANTHROPIC_MODEL is unset the flag
  // vanishes and Claude Code falls back to its own default — unchanged behavior.
  const model = ` \${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}`;
  const cmd =
    `${shellQuote(bin)} -p "$AGENT_TASK" ` +
    `--output-format stream-json --verbose --permission-mode acceptEdits${model}${extra}${persona}`;

  return { command: "bash", args: ["-lc", cmd] };
}

/** POSIX single-quote escaping for values we place into the bash `-lc` string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
