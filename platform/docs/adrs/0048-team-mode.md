# ADR-0048: Team Mode — N agents in parallel on one feature

- **Status:** Accepted (shipped in PR #48; recorded retroactively)
- **Date:** 2026-06-07 (decision); ADR written 2026-06-10 to close the spec+ADR gap (#89)
- **Context issue:** [#48](https://github.com/gagan114662/agent-skills/issues/48) (EPIC #20)
- **Builds on:** [ADR-0004](0004-channels-dms.md), [ADR-0005](0005-realtime-messaging.md),
  [ADR-0009](0009-registry-rbac.md), [ADR-0019](0019-deploy-observability.md),
  [ADR-0025](0025-cloud-execution.md)

> **Numbering note.** Team Mode's demo and spec use the `26` slot (`docs/demos/26-team-mode.*`,
> `docs/specs/26-team-mode.md`), but ADR slot `0026` was already taken by
> [ADR-0026 (Approvals Panel)](0026-approvals-panel.md). To stay collision-free this retroactive ADR
> is numbered by its issue (`0048`). It documents a decision that shipped earlier than the
> higher-numbered ADRs; the date above reflects that.

## Context
Reload runs agents as long-lived members of a channel ([ADR-0025](0025-cloud-execution.md)). The
natural next step for non-trivial work is **a team of agents on one feature at once** — each owning a
slice on its own branch — rather than one agent serialising everything. The hard parts are not
"spawn N sessions": they are (a) **not blowing the sandbox budget** by launching everything at once,
(b) **isolating one agent's failure** so it does not abort the others, and (c) **keeping the humans
and peer agents in the loop** without inventing a new transport. This ADR records how Team Mode does
all three by composing existing seams instead of adding infrastructure.

## Decisions

1. **A `TeamCoordinator` over a `TeamLauncher` seam, not a new runtime.** The coordinator drives a
   run through a structural `TeamLauncher` (`launch` returns immediately; `join` awaits completion) —
   which `SessionManager` ([ADR-0025](0025-cloud-execution.md)) satisfies as-is. Tests inject a fake
   launcher to assert the cap and failure isolation **with no runtime, sandbox, or DB**. Team Mode
   adds orchestration, not a second execution path: every per-session `ResourceCaps`, secret
   redaction, and reaping rule from #25 still applies unchanged underneath.

2. **A bounded async worker pool caps concurrency at the team level.** `runTeam` runs at most
   `maxConcurrency` sessions in flight via a shared cursor over the subtask list (never more workers
   than subtasks). This is the team-level budget guard that sits **on top of** the per-session caps,
   so a 20-subtask run cannot open 20 sandboxes at once.

3. **Failure is isolated per subtask; `runTeam` never rejects.** Each subtask runs independently:
   on error the coordinator posts a `blocked` team event, records `{ ok: false, error }`, and lets
   the peers run to completion. The run resolves with a per-subtask result vector
   (`completed`/`failed` counts), so one crashed agent degrades the run instead of aborting it.

4. **Coordination rides the channel as an encoded "team event", not a new table or socket.** A
   `TeamEvent` (`started | milestone | blocked | needs_handoff | done`, with subtask/agent/branch)
   is encoded into a normal channel message body behind a marker prefix (`::team-event::` + JSON,
   `team/protocol.ts`). The same codec is produced server-side and parsed back out, so peers catch up
   by **reading the channel** (`GET /channels/:cid/team-events`) and an agent harness can emit one by
   simply printing the marker line. The cross-cutting `TeamEvent` *type* lives in `@reload/shared`
   (type-only); the codec lives in the server. **No migration** — Team Mode adds no tables.

5. **Gating + IDOR reuse #9 capabilities and the #25 launch discipline.** `POST
   /channels/:cid/team-runs` needs `write` on the channel; the client supplies only **tasks (data)
   and branch labels — never a host command**. Each subtask's `agentMemberId` must resolve to an
   **agent member of this workspace** (IDOR check) and is granted channel membership + `write` so its
   streamed output and team events land in the channel. The route is **fire-and-forget (202)**: the
   run continues server-side exactly like a single #25 session, so the client can disconnect.

6. **One team rollup span; children link under it.** The whole run is wrapped in a single team trace
   (`tracer.team`), and each child session links via `parentSpanId`, so a run reviews as **one team**
   in Braintrust ([ADR-0019](0019-deploy-observability.md) observability seam). The tracer defaults
   to the no-op, so tests/CI never touch the network; timestamps come from an injectable clock for
   deterministic event assertions.

## Consequences
- A human launches a feature as N subtasks; the agents run in parallel (bounded), coordinate over
  the channel, and the run reports a per-subtask outcome even when some agents fail.
- Team Mode is **pure orchestration over existing seams**: no new runtime, no new transport, no
  migration. The per-session trust/caps/secrets guarantees of #25 are inherited verbatim.
- Concurrency is bounded twice — per session (resource caps) and per team (`maxConcurrency`) — so a
  large team stays under the sandbox budget.
- Coverage: `team-coordinator.test.ts` (cap + failure isolation with a fake launcher),
  `team-protocol.test.ts` (the encode/parse codec is total + strict on `kind`), and
  `test/integration/team-mode.test.ts` (the route + real channel round trip). Demo:
  `scripts/demos/26-team-mode.sh` (recorded video `docs/demos/26-team-mode.mp4`).

## Follow-ups (deferred)
- A web surface for launching/observing a team run (today it is REST-only, like #18's other gaps).
- Cross-subtask handoff automation (the `needs_handoff` event is carried but acted on by humans).
- Dependency ordering between subtasks (today subtasks are independent slices).
- Merge/integration of the per-branch results (left to the #51 git/PR/review surface).
