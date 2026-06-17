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
 *   - `codex`: the real OpenAI Codex CLI in its non-interactive `exec --json` mode against the task,
 *     streaming JSON events back through the runtime. Requires the `codex` binary + `OPENAI_API_KEY`
 *     (resolved through the #25 SecretsResolver and injected as runtime env — never in argv).
 *
 * The spec returned here plugs straight into the existing `{ command, args }` contract consumed by
 * `SessionManager`/`AgentRuntime`, so selecting a harness changes no other code path. A session may
 * pick a harness per launch (#50); the chosen kind is validated against {@link HARNESS_KINDS} and
 * persisted on the session row.
 */
export type HarnessKind = "demo" | "claude-code" | "codex";

/** The full allowlist of harness kinds — the per-session selection is validated against this. */
export const HARNESS_KINDS = ["demo", "claude-code", "codex"] as const;

/** Narrow an untrusted string to a {@link HarnessKind}. The route/manager map a `false` to a 400. */
export function isHarnessKind(value: unknown): value is HarnessKind {
  return typeof value === "string" && (HARNESS_KINDS as readonly string[]).includes(value);
}

export interface HarnessSpec {
  command: string;
  args: string[];
}

export interface HarnessOptions {
  /** Path or name of the Claude Code binary. Default `claude`. */
  claudeBin?: string;
  /** Extra raw flags appended to the claude invocation. */
  claudeExtraArgs?: string[];
  /** Path or name of the Codex binary. Default `codex`. */
  codexBin?: string;
  /** Extra raw flags appended to the codex invocation. */
  codexExtraArgs?: string[];
}

const DEMO: HarnessSpec = { command: "bash", args: ["scripts/agent-harness-demo.sh"] };

export function parseHarnessKind(value: string | undefined): HarnessKind {
  return isHarnessKind(value) ? value : "demo";
}

/**
 * Build the trusted command/args for a harness. Does NOT take the task — the task is supplied at
 * run time as the `AGENT_TASK` env var, so this is pure and injection-safe by construction.
 */
export function harnessSpec(kind: HarnessKind, opts: HarnessOptions = {}): HarnessSpec {
  if (kind === "demo") return { command: DEMO.command, args: [...DEMO.args] };
  if (kind === "codex") return codexSpec(opts);

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
  // Per-agent skills (#155) ride the SAME env-not-argv contract: `AGENT_SKILLS` carries the comma-joined
  // skill ids the session loads (set by `subagents/scope.ts personaHarnessEnv`). It is passed through the
  // job env (not interpolated into argv), so the runtime/provisioner can materialize the agent's versioned
  // knowledge + runbook skills into the session before the model runs; a session with no skills leaves it
  // unset and behavior is unchanged. Surfaced as a `--setting-sources`-adjacent env rather than a
  // fabricated flag, so we never invent a CLI surface Claude Code may not expose.
  // Model + provider selection (#52) reaches Claude Code via env it reads natively (ANTHROPIC_MODEL,
  // ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK/VERTEX, MAX_THINKING_TOKENS, ANTHROPIC_DEFAULT_OPUS_MODEL),
  // so per-session selection is the same injection-safe env seam as the task/persona — never argv. The
  // model is surfaced as an env-gated `--model` flag (double-quoted env reference, like `$AGENT_TASK`)
  // so the chosen model is explicit/overridable per session; when ANTHROPIC_MODEL is unset the flag
  // vanishes and Claude Code falls back to its own default — unchanged behavior.
  const model = ` \${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}`;
  // Redirect the CLI's own stdin from /dev/null. The runtime spawns the harness with a connected stdin
  // PIPE (kept open for live steering, #53), but `claude -p` takes its prompt from argv and never reads
  // that pipe — so the CLI sees a connected-but-empty stdin, waits 3s, then prints "Warning: no stdin
  // data received in 3s, proceeding without it…" to stderr. The runtime captures stderr into the result
  // tail, so that warning leaks in as the FIRST line of every deliverable (the board bug). Pointing the
  // CLI at /dev/null gives it immediate EOF, so the warning is never produced or captured; bash's own
  // stdin stays the steerable pipe (the warning's source was the CLI, not the shell).
  const cmd =
    `${shellQuote(bin)} -p "$AGENT_TASK" ` +
    `--output-format stream-json --verbose --permission-mode acceptEdits${model}${extra}${persona}` +
    ` < /dev/null`;

  return { command: "bash", args: ["-lc", cmd] };
}

/**
 * Build the trusted command/args for the OpenAI Codex CLI. Same injection-safe contract as
 * `claude-code`: the task is `"$AGENT_TASK"` (double-quoted, NOT re-evaluated by bash), so hostile
 * task text cannot break into the command line; the builder takes no task argument.
 *
 * - `exec` is Codex's headless (non-interactive) subcommand — it reads the prompt and runs to
 *   completion without a TTY.
 * - `--json` makes it emit one JSON event per stdout line, which {@link file://./stream-json.ts}
 *   decodes into readable channel turns/tool-calls.
 * - `--full-auto` lets the agent actually edit files in the session workspace without approval
 *   prompts (the runtime — SandboxRuntime — is the isolation boundary for untrusted code).
 *
 * Auth is `OPENAI_API_KEY`, resolved per tenant through the #25 SecretsResolver and injected as
 * runtime env (read by codex natively). It NEVER appears in argv, so it cannot be logged from the
 * command line. Model selection rides the same env seam as the task — an env-gated `--model` flag
 * that references `$CODEX_MODEL` (double-quoted, like `$AGENT_TASK`); when unset the flag vanishes
 * and codex falls back to its own default.
 */
function codexSpec(opts: HarnessOptions): HarnessSpec {
  const bin = opts.codexBin ?? "codex";
  const extra =
    opts.codexExtraArgs && opts.codexExtraArgs.length > 0
      ? " " + opts.codexExtraArgs.map(shellQuote).join(" ")
      : "";
  const model = ` \${CODEX_MODEL:+--model "$CODEX_MODEL"}`;
  // Same stdin-warning defense as claude-code: `codex exec` reads its prompt from argv, so redirect its
  // own stdin from /dev/null (immediate EOF) — the connected-but-empty steering pipe would otherwise
  // make the CLI emit a stdin warning that the runtime captures into the deliverable tail.
  const cmd = `${shellQuote(bin)} exec "$AGENT_TASK" --json --full-auto${model}${extra} < /dev/null`;
  return { command: "bash", args: ["-lc", cmd] };
}

/** POSIX single-quote escaping for values we place into the bash `-lc` string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
