# ADR-0042 — Parse claude-code stream-json into readable channel output

**Status:** Accepted · **Issue:** #81 · **Date:** 2026-06-10 · **Depends on:** #25, #50 ·
**Part of:** EPIC #60

## Context
The `claude-code` harness (#50) is spawned with `--output-format stream-json --verbose`, with the
explicit intent — stated in `harness.ts` — that *"the runtime can surface turns/tool-calls"*. But the
runtime never delivered on it: `SessionManager.runSession()` line-buffers stdout and posts each line
**verbatim** (`emitLine → safePost`). No stream-json parser existed anywhere in the repo, so the
comment's claim was contradicted by the code. With `AGENT_HARNESS=claude-code`, channel users saw one
raw JSON event object per line — `{"type":"assistant","message":{...}}` — instead of readable turns
and tool calls. The default `demo` harness prints plain text, which masked the gap (and is why no test
caught it). Found by a codebase audit (Claude as reviewer): a real gap plus a false claim.

## Decision
Add a **harness-aware output decoder** in the session output path — a small pure module plus an
optional `SessionManager` seam — and select it from the configured harness. **No run-path surgery
beyond the output rendering; no new dependency; no schema/migration.**

- **`runtime/stream-json.ts`** — `decodeClaudeCodeLine(line)` returns
  `{ display: string[]; raw: unknown | null }`:
  - `assistant` → each `text` content block verbatim; each `tool_use` block as a readable
    `🔧 <name> <input-summary>` line (the summary surfaces the dominant arg — `command`, `file_path`,
    etc. — or a compact, truncated JSON).
  - `result` → its final summary text; an error result is flagged with `⚠️`.
  - `system` / `user` (tool results) / unknown → **suppressed from the channel**, but the parsed
    event is returned as `raw` for structured consumers.
  - A non-JSON line passes through **verbatim** (so CLI warnings still surface) with `raw: null`; a
    blank line yields nothing. The decoder is **total** — malformed/unexpected input never throws.
- **`harnessLineDecoder(kind)`** — `claude-code` → the decoder; everything else (`demo`) → a verbatim
  pass-through.
- **`SessionManagerDeps.decodeOutput?: LineDecoder`** — the output path runs each raw line through the
  decoder, **logs the redacted raw event** (run-log / turns consumers), then posts the **redacted**
  `display` lines. Absent → verbatim pass-through (today's behavior).
- **`default.ts`** wires `decodeOutput: harnessLineDecoder(env.harness)` from the #50 env.

## Why this shape
- **Redaction is preserved by construction.** Decoding is *pure rendering*; the manager applies the
  existing redactor **after** the decoder, to both the `display` lines and the `raw` event before it is
  logged. A secret leaked inside an assistant message or a tool input (e.g. a `Bash` command echoing a
  token) is still scrubbed everywhere it could land. This is the #25 boundary, unchanged.
- **Default behavior is byte-for-byte unchanged.** The `demo` harness and any non-`claude-code`
  harness get a verbatim pass-through, so the 422-test suite's streaming/redaction assertions hold and
  a JSON-looking demo line is never reinterpreted.
- **Minimal blast radius.** The decoder is an injected, optional seam — the same pattern as the
  existing `preflight` / `workspace` deps. The heavily-tested run path (provision → stream → reap →
  finalize) is otherwise untouched; only the per-line rendering changed.
- **Raw events stay available.** "Surface turns/tool-calls" needs the structured event, not just text;
  the decoder returns it and the manager logs it (redacted). A durable run-log/turns *store* is a
  separate surface (out of scope), but the data is no longer discarded.
- **Hermetic, spend-free tests.** Synthetic stream-json lines through a fake runtime — no `claude`
  binary, no model spend, no network.

## Consequences
- Channel output for `claude-code` is now readable turns + `🔧` tool calls + the final result, instead
  of raw JSON. The persisted result tail (last N lines) is now readable text rather than JSON blobs.
- Raw events are emitted to the **structured log** (`"agent stream event"`), redacted. A persisted,
  queryable run-log/turns timeline is a documented follow-up — this ADR only stops discarding the data.
- `user`/tool-result events are intentionally **not** rendered into the channel (noise); the issue
  scopes assistant/tool_use/result. Surfacing tool *results* is a follow-up if wanted.
- **Streamed-post ordering (fixed in this PR).** Touching the output path surfaced a latent race: the
  per-line channel posts were fire-and-forget (`void safePost`), so they could land out of order or
  remain in flight when the session went terminal — a consumer reading right after completion saw
  streamed lines reordered or missing. The posts are now serialized through one chain and **flushed
  before the terminal message + finalize**, so the channel reflects the full, ordered output by the
  time the session is `completed`. `safePost` still never rejects, so the chain can't break the run.

## Alternatives considered
- **Parse in `LocalRuntime`/`SandboxRuntime`.** Rejected: the runtimes are thin process backends that
  stream bytes; rendering is a presentation concern that belongs at the channel boundary
  (`SessionManager`), and a per-backend parser would duplicate logic. The decoder seam keeps both
  backends unchanged.
- **Always parse every line (no harness gating).** Rejected: a `demo` (or future) harness that happens
  to print JSON would be silently reinterpreted. Gating on the harness kind keeps non-`claude-code`
  output verbatim — the regression test pins this.
- **Drop `--output-format stream-json` and use plain `--print`.** Rejected: it throws away the
  structured turns/tool-calls the harness was deliberately configured to emit (the whole point of
  #50's real-harness path), and would still need light parsing for tool calls.
- **Persist raw events to a new `run_log` table now.** Rejected as scope creep — needs a migration and
  a consumer. Logging the redacted event unblocks structured consumers without new schema; the store is
  a follow-up.
