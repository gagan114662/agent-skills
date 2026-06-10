# Spec 27 — Real coding-agent harness (#50)

## Goal
Replace the demo *echo* harness with a real, model-agnostic coding-agent harness, selectable per
deployment, that runs inside the existing `AgentRuntime` (Local + Vercel Sandbox) with no change to
the session lifecycle, streaming, secret-redaction, or reaper.

## Background
`SessionManager` spawns a trusted `{ command, args }` for each session and injects the task as the
`AGENT_TASK` env var; the demo harness (`bash scripts/agent-harness-demo.sh`) just echoes it. Nothing
real codes. This is issue #50, the keystone that unblocks #51–#59.

## Design
A **harness** is the trusted command spawned per session. Selection is config-only and produces the
same `{ command, args }` contract the runtime already consumes, so no downstream code changes:

- `demo` (default) — unchanged; dev/CI, no model spend.
- `claude-code` — `bash -lc "claude -p \"$AGENT_TASK\" --output-format stream-json --verbose --permission-mode acceptEdits"`.

Selection via `AGENT_HARNESS` (`demo` | `claude-code`); `CLAUDE_BIN` and `ANTHROPIC_MODEL` tune the
claude invocation; `AGENT_HARNESS_CMD` / `AGENT_HARNESS_ARGS` still override everything.

The **deployment-wide default model** is `ANTHROPIC_MODEL` (set in `.env.example`, `fly.toml [env]`,
and documented in `PLATFORM-ENV-SETUP.md`). Owner directive: live ipop agents default to
`claude-fable-5`. Per-session model selection (#52) still overrides it via the merged session env.

### Security
The task/prompt is **never** interpolated into argv — it is passed at run time as `AGENT_TASK` and
referenced as a double-quoted `"$AGENT_TASK"`, which bash does not re-evaluate. Hostile task text
cannot inject shell. Binary/model values we place into the `-lc` string are POSIX single-quoted.
Secrets continue to flow through `SecretsResolver` → runtime env and are redacted from output.

## In scope
- `harness.ts`: `HarnessKind`, `parseHarnessKind`, `harnessSpec(kind, opts)`.
- `env.ts`: select harness from `AGENT_HARNESS`; keep explicit overrides.
- Unit tests for spec construction, overrides, and injection-safety.

## Out of scope (follow-ups)
- Codex / Gemini adapters (extend `HarnessKind`).
- Structured parsing of the `stream-json` events into typed turns/tool-calls (feeds #51 review UI).
- Subagents (#59) and plan mode (#53), which layer on top of the harness.

## Acceptance
- Default behavior unchanged (demo); 170+ existing tests stay green.
- `AGENT_HARNESS=claude-code` produces a real `claude` invocation under Local and Sandbox runtimes.
- Task text cannot escape into the command line (tested).
- ADR-0027 records the harness abstraction + first-class agent choice.
- Demo (recorded video pending): a real agent edits code in a session and streams its work to the
  channel; `bash scripts/agent-harness-demo.sh` exercises the harness-selection seam spend-free.

## Remaining scope completed (#50, follow-up)
The keystone (`demo` + `claude-code`, env-selected) shipped earlier. This follow-up closes the issue:

- **`codex` adapter.** `HarnessKind` gains `codex`; `harnessSpec("codex")` returns
  `bash -lc "'codex' exec \"$AGENT_TASK\" --json --full-auto ${CODEX_MODEL:+--model \"$CODEX_MODEL\"}"`.
  Same injection-safe contract as claude-code: the task is the quoted `"$AGENT_TASK"` env reference,
  the builder takes no task argument, the binary is POSIX single-quoted. Auth is `OPENAI_API_KEY`,
  resolved through the #25 `SecretsResolver` and injected as runtime env — **never in argv**, so it
  cannot be logged from the command line. A codex `exec --json` stream decoder
  (`stream-json.ts → decodeCodexLine`) renders agent messages, command executions, and file changes
  into readable channel lines (lifecycle/reasoning events suppressed, raw preserved), mirroring the
  claude-code decoder so redaction still applies after decoding.
- **Per-session harness selection.** `POST /channels/:cid/agent-sessions` accepts an optional
  `harness` kind, validated against the `HARNESS_KINDS` allowlist (unknown → 400). `SessionManager`
  resolves the per-session override (or the env default) to a trusted spec + decoder **before** it
  persists or touches the runtime, persists the chosen kind on the session row (`agent_sessions.harness`,
  migration `0050`), and feeds the resolved `{ command, args }` to the runtime — so switching
  claude-code ↔ codex per session is honored identically under `LocalRuntime` and `SandboxRuntime`
  (both only ever see command/args/env). An invalid kind, or an override with no resolver wired, is
  rejected (`HarnessKindError`) without leaving a half-started session.

Out of scope (still): Gemini/OpenCode adapters; typed turn/tool-call persistence (run log).
