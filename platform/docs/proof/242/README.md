# #242 — Agent sessions run to completion (mid-run error fixed + surfaced)

**Live, end-to-end, with the REAL `claude` binary** against real Postgres + the real channel poster +
the production outcome/incident wiring. Briefed `@scout` (#seo) the issue's SEO brief, exactly as the
marketing @mention path does (draft-only tools, persona prompt).

## Root cause (read from the actual runtime error)

The harness emits `--model "$ANTHROPIC_MODEL"` (#52). `fly.toml` set `ANTHROPIC_MODEL = "claude-fable-5"`
— a model the API can't serve. So every `claude-code` session ran `claude -p … --model claude-fable-5`,
the API rejected it, `claude` exited **1** having produced nothing, and the error text (no `401`/`402`)
fell into the generic `error` bucket → the owner saw only "I hit an error mid-run · error · exit 1".

Reproduced verbatim locally:

```
$ claude -p "…" --model claude-fable-5 --output-format stream-json --verbose
EXIT=1
result event: is_error=true,
  "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it."
```

## Fix

1. **Config (root cause):** `claude-fable-5` → `claude-sonnet-4-6` (project-canonical default) in the three
   in-sync sites (`fly.toml`, `.env.example`, `PLATFORM-ENV-SETUP.md`) + docs.
2. **Surface the real error:** new `"model"` failure class (`runtime/outcome.ts`) with owner-actionable
   copy — propagates to the terminal message, mission-control `recentFailures`, and the `diagnose`
   headline. Real error excerpt now rides the failure event into the incident/flywheel detail.
3. **Self-heal (#193):** a model misconfig opens a deduped, escalating `self_healing_remediations` incident
   on a DISTINCT `agent-model` surface (`self-healing/model-incident.ts`), routed ONLY to the incident
   (never the auto-fix flywheel — it's owner-actionable config). It auto-resolves on the next clean
   session (the captured retry / self-heal loop). Every approval gate + the #223 quarantine are untouched.

## LIVE proof A — FIXED model (`claude-sonnet-4-6`): runs to completion, real artifact

See [`happy.log`](./happy.log). Board went **WORK IN PROGRESS 1 → completed (exit 0)** and landed a real
drafted SEO article in #seo (title tag, 155-char meta description, headers, ~150-word body, **$49 trial
CTA**, target keyword) — terminal message `✅ session completed (exit 0)`. **0** self-healing incidents.

## LIVE proof B — BAD model (`claude-fable-5`): actionable surface + incident

See [`bad.log`](./bad.log). Session **failed exit 1** (reproduces the prod bug), but now:
- the real cause is in-thread: `⚠️ There's an issue with the selected model (claude-fable-5)…`
- the terminal message is **actionable**, not opaque:
  `❌ The model this workspace is set to use isn't available (model) … Pick a valid model in Settings → Model … @mention me again and I'll pick this right up.`
- **1** self-healing incident opened on the `agent-model` surface (the founder console's `selfHealingOps`).

## Gates

`pnpm typecheck` ✓ · `pnpm lint` ✓ · server unit `2416` ✓ · web `372` ✓ · `pnpm build` ✓ ·
skill-colocation ✓ · integration `agent-sessions` 6/6 ✓ (incl. the new deterministic #242 model-incident
test against real Postgres).
