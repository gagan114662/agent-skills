# ADR-0319: Honest session disposition — a failed-to-start run is never done/shipped, and the spawn tool is provisioned (flag-gated)

- **Status:** Accepted (shipped in PR for #319)
- **Date:** 2026-06-17
- **Context issue:** [#319](https://github.com/gagan114662/agent-skills/issues/319) — "P0: agent runtime
  cannot boot (missing spawn tool); failed sessions mislabeled done."
- **Builds on:** #166 (the pure `classifyFailure` / `renderSessionOutcome` — the green-check-only-on-success
  rule and the `spawn`/`auth`/`timeout`/`budget`/`model` reason taxonomy), #251 (`harnessEventReportsError`
  — an exit-0 run can still fail) and the #248 deliverable sink, [ADR-0200](0200-premortem-panel.md) (the
  premortem — FM#2 *self-reported metrics are fiction*, FM#3 *verification that never touches reality*),
  [ADR-0123](0123-marketing-department-fleet.md) (the drafts-only persona tool ceiling),
  [ADR-0243](0243-money-only-approval.md) + [ADR-0295](0295-deliverable-delivery.md) (money-only gate +
  external-receipt delivery), and the `venture`/`agentRegistry` owner-workspace-first config pattern.

## Context

Two board bugs, both reported as "the agent posts *I could not start up — my runtime is missing a tool I
need (spawn). session failed, exit n/a*", and separately *the "5-tweet launch thread" card shows as
done/shipped even though the session never started.*

1. **The `(spawn)` message is a failure CLASS, not a literal tool.** `renderSessionOutcome` renders
   `_(spawn)_` whenever `classifyFailure` buckets a run as `spawn` (historically: a process that never
   returned an exit code — ENOENT). Its copy ("my runtime is missing a tool I need") is, as the code
   itself notes, *misleading* — there is no tool literally named `spawn`. So part of the bug is honesty.

2. **A clean exit was trusted as "done" on too little evidence.** `claude -p` can BOOT, fail to find a tool
   its runtime needs, report that to the user as an ordinary assistant message, and exit **0 with a
   non-error `result` event** (`is_error: false`). Neither the exit code (0) nor #251's
   `harnessEventReportsError` (which keys on `is_error: true`) flags it. The #248 sink then surfaced a
   deliverable whose entire content was "I couldn't start up", and — being a non-money draft (ADR-0243) —
   it auto-routed to Done (`executed`), i.e. the **shipped** board lane. A shipped card for a session that
   never started. This is exactly the premortem's FM#2/FM#3: a green dashboard over a run that never
   touched reality.

3. **The fleet had no way to collaborate.** Department personas carry a drafts-only ceiling
   (`Read, Grep, Glob, WebSearch, WebFetch`, ADR-0123) and no subagent-**spawn** tool, so a lead cannot
   delegate to a teammate.

## Decision

### 1. One honest disposition (`decideSessionDisposition`) — the single source of truth

A new pure function in `runtime/outcome.ts` maps a finished run to `{ status, done, failureClass }`:

- A non-clean terminal status (`failed`/`timeout`/`canceled`/…) is already a failure — classified + kept.
- A clean exit whose stream ended in a harness error event (#251) → `failed`, not done.
- A clean exit whose **output is a self-reported startup failure** (#319) → `failed`, not done. We believe
  the agent's own words ("I couldn't start up — my runtime is missing a tool") over the zero exit code.
  `classifyFailure` now buckets such content as `spawn` even on exit 0, so the owner sees the right copy.
- A clean exit with **no produced artifact** → `completed` but **not done** (nothing to surface). This
  preserves the prior "empty output ⇒ no deliverable, but not a hard failure" behaviour exactly.
- Otherwise → **done**: a real, output-bearing clean completion.

`SessionManager.runSession` now calls this once and keys EVERY downstream consumer off it — the terminal
message (`result.status`), `store.finalize`, failure routing, recovery, and crucially the #248 deliverable
gate, which is now `disposition.done` (was `isSuccess && resultText.trim()`). So a failed-to-start,
harness-errored, or no-artifact run can never surface as a done/shipped card. `done` is the
production-grounded proof the premortem (#200) demands: **assert the agent actually booted and produced
real output before any done state.**

Startup-failure detection (`looksLikeStartupFailure`) inspects only the HEAD of the artifact (first 400
chars) and matches START-anchored phrases ("could not start up", "my runtime is missing a tool"), so a
genuine deliverable that merely *mentions* a missing tool is never misread as a boot failure.

External-receipt discipline is unchanged and unweakened: a real **publish/send** still ships only through
the #295 `DeliveryDispatcher`, which refuses to dispatch without an owner-approval id; the `agent.deliverable`
record is a money-free, reversible acknowledgement (ADR-0243), now additionally gated on a real artifact.

### 2. Provision the spawn tool — flag-gated, default OFF, owner-workspace-first

`SPAWN_TOOLS = ["Task"]` (Claude Code's subagent-spawn tool) is unioned into a scoped session's
`--allowedTools` via a new `extraTools` channel on the existing `personaHarnessEnv` seam (the same seam the
always-on #250 web tools ride). Unlike the read-only web tools, spawn multiplies model spend and is a
bounded-autonomy concern (#200 §5), so it is **never** unioned unconditionally:

- A new `agentCollaboration` config block (`enabled` default **false**, `ownerWorkspaceOnly` default
  **true**, `ownerWorkspaceId`) mirrors `venture`/`agentRegistry` exactly.
- The pure `isSpawnEnabledForWorkspace` gate provisions spawn only for the named owner workspace until the
  owner broadens it (`ownerWorkspaceOnly: false`). Turning `enabled` on without naming the owner workspace
  provisions for nobody — the safest default.
- `SubagentService` gained an injectable `extraToolsForWorkspace`; the marketing @mention path and the
  `/personas` route bind it to `spawnToolsForWorkspace`. A deployment that sets nothing keeps today's
  drafts-only surface byte-for-byte (empty `extraTools` ⇒ unchanged allowlist).

The task text the spawning agent passes is still injection-safe (env-not-argv, ADR-0123/#50); spawn grants
no new authority — a spawned subagent runs under the same persona-member grants, and anything that leaves
the building still routes through the #13 gate. Irreversible/real-spend actions remain pre-committed and
human-gated (ADR-0243/#13).

## Consequences

- **No migration, no new table** — the disposition is pure; the capability is config-resolved.
- **Default-OFF preserved.** Spawn provisioning ships OFF + owner-first; the disposition change only ever
  *downgrades* a lying success — a real completion is unaffected, so existing happy-path tests stay green.
- **The only behaviour change** for an existing session is: a clean-exit run whose output is a self-reported
  startup failure (or a harness error) now surfaces as **failed**, never done/shipped. Empty-output clean
  exits keep their prior "completed, no deliverable" behaviour.
- **Honest copy.** A self-reported boot failure now reads as `spawn` ("couldn't start up — missing a tool")
  rather than a generic error, matching what the owner actually sees.
- **Full unit coverage** for the failure-to-status mapping: `decideSessionDisposition`,
  `looksLikeStartupFailure`, the new `classifyFailure` content rule, the `agentCollaboration` caps + gate,
  the `personaHarnessEnv` extra-tools union, and an end-to-end `SessionManager` test proving a
  startup-failure-on-exit-0 yields no deliverable card, a `failed` finalize, and a routed `spawn` failure.
