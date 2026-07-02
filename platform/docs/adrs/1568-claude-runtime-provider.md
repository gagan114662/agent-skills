# ADR-1568: Switch the agent runtime provider to Claude (Anthropic), keep Codex pluggable

- Status: accepted
- Date: 2026-07-02
- Issue: switch-agent-runtime-to-claude (owner decision)

## Context

The deployed fleet executed team runs on the OpenAI Codex CLI: the `prod` posture preset pinned
`harness: "codex"`, the `/everyday` room and the messaging inbound launch hardcoded
`preferredHarness: "codex"` per subtask, and every launch was gated on the Codex-only
`/me/codex/status` doctor probe. Live QA (2026-07-02) showed the cost of that hard dependency: prod
briefs returned 201 but agents never spawned — transcripts leaked `codex_core::shell_snapshot`
errors ("Unterminated quoted string") and Scout hung forever with 0 drafts. The Claude Code harness
(`claude-code`) already existed behind the same #50 harness seam and the fleet models were already
Claude models (#246), but nothing let the deployment *default* to it.

## Decision

1. **Provider abstraction** (`runtime/provider.ts`): a `RuntimeProvider = "claude" | "codex"`
   resolved from `AGENT_RUNTIME_PROVIDER` (default **`claude`**), mapping 1:1 onto the existing
   harness kinds (`claude` → `claude-code`, `codex` → `codex`). The posture `prod` preset, the
   team-run route, the `/everyday` dispatch, and the messaging inbound launch all key off the ONE
   resolved provider; `AGENT_RUNTIME_PROVIDER=codex` restores the legacy posture without a deploy.
2. **Provider-agnostic readiness**: new `GET /me/runtime/status` returns a `RuntimeStatus`
   (superset-compatible evolution of the Codex shape — same fields, widened unions, plus
   `provider`). The legacy `/me/codex/status` + `/me/codex/preflight` paths now serve the SAME
   provider-agnostic status so older web bundles keep working through the switch. The team-run
   preflight gates per NEEDED harness: codex subtasks on the Codex doctor, claude-code subtasks on
   Claude readiness; `demo` never gates.
3. **Claude auth = subscription FIRST, always** (owner decision 2026-07-02): agents run on the
   owner's Claude subscription, not an API key. `decideAgentAuth` precedence:
   (1) the workspace's own connected subscription token (#246 unchanged — per-tenant billing wins),
   (2) the deployment env's **`CLAUDE_CODE_OAUTH_TOKEN`** (headless `claude setup-token` output,
   the owner's Fly secret) — the PRIMARY server credential,
   (3) the deployment env's `ANTHROPIC_API_KEY` — an OPTIONAL fallback only,
   (4) nothing (the gate posts a connect prompt instead of launching).
   `GET /me/runtime/status` reports the decision as `authMode: "subscription" | "api_key" | null`,
   derived from the SAME resolver the launch secrets path uses so status and launch never disagree.
   Every credential is env/vault-read only — never hardcoded, never persisted, redacted from
   streamed output like every injected secret.
4. **Web**: the `/everyday` shell asks `getRuntimeStatus()` and launches every subtask on the
   server-selected harness — no hardcoded vendor. The "Codex" operator role is renamed
   "Operator"; the persisted `codex_operator_lane` audit label + receipt prefix are kept so
   existing audit rows keep matching.

## Consequences

- Fresh deploys run the fleet on Claude via the Claude Code CLI; the codex binary is no longer on
  the critical path (its preflight checks only run when the codex harness is actually selected).
- **The deployed server needs `CLAUDE_CODE_OAUTH_TOKEN` in its Fly env** — the owner runs
  `claude setup-token` and sets the output as a Fly secret so agent runs bill the owner's Claude
  subscription. `ANTHROPIC_API_KEY` may be set as an optional fallback; a workspace-connected
  subscription token (Settings → Connect Claude) also works. Without any of these, runs block with
  an actionable 409/connect prompt.
- Send/spend approval-gate behavior is untouched — this ADR changes model execution auth only.
- Rollback: set `AGENT_RUNTIME_PROVIDER=codex` (no code change).
