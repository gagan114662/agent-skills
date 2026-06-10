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
