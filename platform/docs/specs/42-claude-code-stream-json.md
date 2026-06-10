# Spec 42 — Parse claude-code stream-json into readable channel output (#81)

> Implements [#81](https://github.com/gagan114662/agent-skills/issues/81). Closes the #50/#60
> real-harness gap: the harness *requests* stream-json but the runtime never parsed it. Lifecycle:
> **BUILD** artifact (TDD). Built the agent_skills way — failing test first, one atomic PR, no merge
> without approval + video.

## Goal
Make the **`claude-code`** harness produce **readable** channel output. The harness is spawned with
`--output-format stream-json --verbose` (so the runtime can surface turns/tool-calls), but
`SessionManager.runSession()` posts each raw stdout line verbatim — there is **no stream-json parser
anywhere**. With `AGENT_HARNESS=claude-code`, channel users see one raw JSON event object per line
instead of readable assistant turns and tool calls. The default `demo` harness (plain text) masked
the gap. Add a harness-aware decoder in the session output path that renders
`assistant`/`tool_use`/`result` events as readable text, keeps the raw event for structured
consumers, leaves demo output unchanged, and keeps redaction applying after decoding.

## Background
`harness.ts` (#50) builds `claude -p "$AGENT_TASK" --output-format stream-json --verbose
--permission-mode acceptEdits` with the comment *"Print mode + JSON stream so the runtime can surface
turns/tool-calls"*. But `manager.ts` line-buffers stdout (`onOutput` → split on `\n` → `emitLine`)
and posts each line verbatim (`emitLine → safePost`). The claim in the comment was contradicted by
the code: no decoder existed. Claude Code's stream-json is newline-delimited JSON — `system`/`init`,
`assistant` (with `text` and `tool_use` content blocks), `user` (tool results), and a final `result`
event.

## In scope
- **Stream-json decoder** (`runtime/stream-json.ts`): `decodeClaudeCodeLine(line)` →
  `{ display: string[]; raw: unknown | null }`.
  - `assistant` → each `text` block verbatim; each `tool_use` block as `🔧 <name> <input-summary>`.
  - `result` → its final summary text; error results flagged with `⚠️`.
  - `system` / `user` / unknown → suppressed from the channel, raw event preserved.
  - Non-JSON line → passed through verbatim (CLI warnings still surface), `raw: null`; blank → nothing.
- **Harness-aware factory** `harnessLineDecoder(kind)`: `claude-code` → the decoder; everything else
  (`demo`) → a verbatim pass-through, so default output is byte-for-byte unchanged.
- **Runtime wiring**: optional `decodeOutput` seam on `SessionManager`; the output path decodes each
  line, posts the readable `display` lines, preserves the `raw` event to the structured log for
  run-log/turns consumers, and **applies redaction after decoding** (display + raw alike).
- **Production wiring**: `default.ts` selects the decoder from `env.harness`.

## Out of scope (follow-ups)
- A durable raw-event store / turns timeline UI (raw events go to the structured log today; a
  persisted run-log is a separate surface).
- Rendering `user`/tool-result events into the channel (noise; the issue scopes assistant/tool/result).
- Streaming partial assistant deltas (Claude Code emits whole content blocks per event).

## Trust & safety boundary
- **Redaction is applied *after* decoding** — a secret leaked inside a decoded event or tool input is
  scrubbed before it is posted to the channel **or** written to the structured log (the `raw` event is
  redacted before logging too). The #25 redaction boundary is preserved.
- **Pure rendering.** The decoder never executes anything, never touches argv, and is total: malformed
  JSON, unexpected shapes, and missing fields degrade to a pass-through or empty display — never throw.
- **Default behavior unchanged.** The `demo` harness (and any non-`claude-code` harness) gets a
  verbatim pass-through; a JSON-looking demo line streams exactly as printed.

## The seam
```
runtime/stream-json.ts
  decodeClaudeCodeLine(line) -> { display: string[]; raw: unknown|null }
  harnessLineDecoder(kind: HarnessKind) -> LineDecoder    // claude-code → decoder; else passthrough

runtime/manager.ts
  SessionManagerDeps.decodeOutput?: LineDecoder           // absent → verbatim passthrough (demo behavior)
  runSession(): emitLine() decodes → logs redacted raw event → posts redacted display lines

runtime/default.ts
  decodeOutput: harnessLineDecoder(env.harness)           // production selection from #50 env
```

## Testing strategy (TDD)
- **Unit — `test/unit/stream-json.test.ts`** (decoder, hermetic): assistant text renders readable +
  raw preserved; tool_use surfaces as `🔧 <name> <input>`; mixed text+tool order; result success →
  summary; result error → `⚠️`; system/init suppressed but raw kept; non-JSON pass-through; blank →
  nothing; factory returns the decoder for `claude-code` and a verbatim pass-through for `demo`
  (a JSON-looking demo line is **not** parsed).
- **Unit — `test/unit/session-manager.test.ts`** (output path): a claude-code stream-json burst yields
  readable assistant text + a surfaced tool call and **no raw JSON blob** in the channel; **demo
  regression** — a demo decoder leaves a JSON-looking line verbatim; **redaction** still scrubs a
  secret from decoded claude-code channel output.

## Success criteria
1. `claude-code` stream-json lines render as readable channel text; tool calls are surfaced; no raw
   JSON blob reaches the channel.
2. Raw events remain available for structured consumers (logged, redacted).
3. Demo-harness output is byte-for-byte unchanged.
4. Redaction still applies after decoding (channel + structured log).
5. `pnpm -C platform typecheck && lint && test` green. Spec 42 + ADR-0042; one atomic PR linking #81;
   **not** merged without approval + video.

## Plan (atomic)
1. Failing tests: `stream-json.test.ts` + `session-manager.test.ts` additions — *RED*.
2. `runtime/stream-json.ts` decoder + factory — *GREEN*.
3. `runtime/manager.ts` `decodeOutput` seam + decode/redact/preserve-raw in the output path.
4. `runtime/default.ts` wiring from `env.harness`.
5. Spec 42 + ADR-0042 + PR.
