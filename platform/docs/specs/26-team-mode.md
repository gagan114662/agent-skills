# Spec: Reload Platform — Team Mode (N agents in parallel on one feature) (Issue #48)

> Implements [#48](https://github.com/gagan114662/agent-skills/issues/48). Part of EPIC #20.
> Depends on #25 (cloud execution / `SessionManager`), #4/#5 (channels + realtime), #9 (RBAC),
> #19 (observability).
> **Retroactive spec** — written 2026-06-10 (#89) to restore the "every feature has a spec + ADR"
> convention for code that shipped in PR #48. See [ADR-0048](../adrs/0048-team-mode.md).

## Objective
**What:** Launch **N agents in parallel on one feature**, each owning a subtask on its own branch,
coordinating through the channel's shared team protocol — with a team-level concurrency cap, failure
isolation, and a single observability rollup.

**Why:** Reload runs agents as long-lived channel members (#25). Non-trivial work is faster and more
natural as **a team** — several agents working slices at once — than as one agent serialising
everything. The risks to manage are sandbox **budget** (don't open N sandboxes at once), **failure
blast radius** (one agent must not abort the team), and **coordination** (peers + humans must stay in
the loop) — all solved by composing existing seams, not new infrastructure.

**Who:** A human (or an orchestrating agent) who breaks a feature into subtasks and launches them as
one run; the agent members who execute the subtasks and emit lifecycle events; operators who need the
run bounded, isolated, and observable.

### Acceptance criteria
1. `POST /channels/:cid/team-runs` accepts a non-empty `subtasks[]` (`{ agentMemberId, task, branch }`),
   validates all-or-nothing up front, and returns **202** with the `teamRunId` + per-subtask ids; the
   run continues server-side (the client can disconnect).
2. At most `maxConcurrency` sessions run in flight (team-level cap on top of #25's per-session caps).
3. One subtask failing posts a `blocked` team event and is reported `{ ok: false }`; the others run to
   completion. `runTeam` **never rejects**.
4. Coordination events (`started | milestone | blocked | needs_handoff | done`) are carried as channel
   messages and readable via `GET /channels/:cid/team-events` (read capability; optional `?limit=N`).
5. RBAC + IDOR: launch needs `write` on the channel; every subtask `agentMemberId` must be an **agent
   member of this workspace**; the caller supplies tasks (data) + branch labels, **never a host
   command**. Each agent is granted channel membership + `write` so its output/events land there.
6. The whole run is one observability rollup span; child sessions link under it (`parentSpanId`).
7. ADR + this spec + demo `docs/demos/26-team-mode.mp4` (script: `scripts/demos/26-team-mode.sh`);
   PR links #48; **not** merged without approval.

### In scope
- **Coordinator** (`apps/server/src/team/coordinator.ts`): `TeamCoordinator` over a `TeamLauncher`
  seam (`SessionManager` satisfies it structurally), an async worker pool bounded by `maxConcurrency`,
  per-subtask failure isolation, and the team rollup span.
- **Channel protocol** (`apps/server/src/team/protocol.ts`): encode/parse a `TeamEvent` into a channel
  message body behind the `::team-event::` marker — total + strict on `kind` so ordinary chatter
  parses cleanly. The `TeamEvent` type lives in `@reload/shared` (type-only); the codec lives server-side.
- **Routes** (`apps/server/src/routes/team.ts`): launch (202, fire-and-forget) + read-events, gated by
  #9 capabilities and the #19 tenant guard, mirroring #25 agent-sessions.

### Out of scope (follow-ups)
- A **web UI** to launch/observe a team run — REST-only today (UI is a follow-up alongside #18).
- Cross-subtask **handoff automation** (`needs_handoff` is carried but acted on by humans).
- **Dependency ordering** between subtasks (today they are independent slices).
- **Merging** the per-branch results → the #51 git/PR/review surface.

## Success criteria
1. The route launches a bounded, fire-and-forget run with up-front validation + IDOR scoping.
2. Concurrency never exceeds `maxConcurrency`; one failing subtask never aborts its peers.
3. Team events round-trip through the channel and read back via the events endpoint.
4. `pnpm -C platform typecheck && lint && test && build` green; integration green.
5. ADR-0048 + this spec + demo `docs/demos/26-team-mode.mp4` (script: `scripts/demos/26-team-mode.sh`);
   PR links #48; **not** merged without approval.

## Tests
- **Unit (hermetic, no DB):** `team-coordinator.test.ts` — the worker pool honours `maxConcurrency`
  and isolates a failing subtask (fake `TeamLauncher`, injectable clock); `team-protocol.test.ts` —
  encode→parse is lossless and `tryParseTeamEvent` is total + strict on `kind`.
- **Integration (real Postgres + `LocalRuntime`):** `test/integration/team-mode.test.ts` — launch a
  team run into a channel, assert events land and read back, and the per-subtask results vector is
  correct.
