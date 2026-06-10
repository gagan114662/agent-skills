# ADR-0027 — Real coding-agent harness (selectable, injection-safe)

**Status:** Accepted · **Issue:** #50 · **Date:** 2026-06-09

## Context
Our `AgentRuntime` orchestrates sessions but spawns a demo *echo* harness — nothing real codes.
Conductor has driven real agent binaries (Claude Code, Codex, Gemini CLI) model-agnostically since
its first releases. We need a real harness without disturbing the session lifecycle, the
Local/Sandbox runtimes, secret redaction, or the reaper.

## Decision
Introduce a thin **harness selection** layer (`runtime/harness.ts`) that returns the existing
`{ command, args }` contract:

- `demo` (default) keeps `bash scripts/agent-harness-demo.sh`.
- `claude-code` returns `bash -lc "<claude … print/stream invocation>"`.

The task is injected at run time via the `AGENT_TASK` env var (the demo harness's existing
contract) and referenced as a quoted `"$AGENT_TASK"` — **never** interpolated into argv — so
untrusted task text cannot inject shell. The binary path and model are POSIX single-quoted.

Selection is config-only (`AGENT_HARNESS`, `CLAUDE_BIN`, `ANTHROPIC_MODEL`), with
`AGENT_HARNESS_CMD`/`AGENT_HARNESS_ARGS` as explicit escape hatches.

## Why this shape
- **Zero blast radius.** Reusing `{ command, args }` + `AGENT_TASK` means `SessionManager`, both
  runtimes, and all existing tests are untouched; only config changes behavior.
- **Injection-safe by construction.** `harnessSpec()` takes no task argument, so hostile prompts
  cannot reach the command line.
- **Model-agnostic & extensible.** Adding Codex/Gemini is a new `HarnessKind` branch.

## Consequences
- A live `claude-code` run needs the `claude` binary + auth in the execution environment (host for
  Local, the image for Sandbox) — an operational prerequisite, not a code dependency; CI stays on
  `demo`.
- The `stream-json` output currently flows through as text; typed parsing into turns/tool-calls is
  a follow-up that feeds the #51 review UI.

## Alternatives considered
- **Change `SessionManagerDeps.harness` to a `Harness` object** with a `build(task)` method —
  cleaner OO, but it would interpolate the task and touch every call site + test for no functional
  gain. Rejected in favor of the config-only seam.

## Follow-up (#50 remaining scope): codex adapter + per-session selection
- **`codex` is a new `HarnessKind` branch**, exactly as anticipated: `codex exec --json --full-auto`
  with the task as the quoted `"$AGENT_TASK"` env reference and an env-gated `--model "$CODEX_MODEL"`.
  Auth is `OPENAI_API_KEY` via the #25 secrets→env path — never argv. A `decodeCodexLine` decoder
  renders codex's thread/item events into readable channel text, mirroring the claude-code decoder.
- **Per-session harness selection** extends the config-only seam to per-launch without breaking the
  zero-blast-radius principle: `SessionManagerDeps` keeps the default `{ command, args }` and gains
  an optional `harnessKind` (persisted default) + a pure `harnessOverrides(kind) → { command, args,
  decode }` resolver. `LaunchInput.harness` (validated against `HARNESS_KINDS`) selects per session;
  the manager resolves a spec + decoder before persisting, records the kind on `agent_sessions.harness`
  (migration `0050`), and passes the resolved spec to the runtime — so both runtimes honor the switch
  identically. The resolver is still task-free, so per-session selection adds no injection surface.
  We kept `{ command, args }` rather than the rejected `Harness` object: the resolver returns that
  same contract, so the runtimes and the streaming/reaper/redaction paths remain untouched.
