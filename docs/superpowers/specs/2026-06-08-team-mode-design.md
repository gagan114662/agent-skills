# Team Mode — Design

**Date:** 2026-06-08
**Scope:** `platform/apps/server` (Fastify 5 + TS) + `platform/packages/shared`
**Status:** Approved (Gagan, 2026-06-08)

## Goal

Run **N cloud agents in parallel on one feature**, each on its own subtask/branch, while
keeping them in the loop with each other. A run is launchable, observable as one team, and
finishes with all branches mergeable without conflicts.

Four capabilities:

1. **Parallel execution** — a Coordinator launches N agent sessions concurrently against one
   workspace, each on its own subtask/branch, on the configured `AGENT_RUNTIME` (sandbox in prod,
   local in dev/CI). Respects the existing per-session `ResourceCaps` and adds a configurable
   **max-concurrency** cap so we never exceed the sandbox budget.
2. **Keep-each-other-in-the-loop** — a shared "team channel" protocol. Agents post structured
   status events (`started`, `milestone`, `blocked`, `needs_handoff`, `done`) and read peers'
   recent events before acting, avoiding duplicate/conflicting work.
3. **Observability** — each session is wrapped in the existing Braintrust `AgentTracer` span; a
   team-level rollup span links the child sessions so a run reviews as one team. No network calls
   when `BRAINTRUST_API_KEY` is unset.
4. **Demo** — a script that launches 3 agents on 3 independent subtasks of one feature, shows them
   coordinating over the team channel (logs the event stream), and finishes with all branches
   mergeable without conflicts.

## Non-goals (YAGNI)

- No new `team_runs` DB table. Team events ride on channel **messages** (REST = source of truth),
  consistent with the existing realtime design (no event store).
- `ResourceCaps` is **not** extended. Max-concurrency is a distinct team-level cap, not a per-session
  field.
- No changes to the WS gateway: team events publish on the existing `rt:channel:<id>` key.

## Architecture

New module `src/team/`, mirroring the `runtime/` and `autonomy/` conventions (injected deps,
pure logic split from side effects, a `default.ts` factory).

```
packages/shared/src/index.ts     ← TeamEvent DTO + encode/tryParse (plain TS, no deps)
apps/server/src/
  team/
    coordinator.ts                ← TeamCoordinator: concurrency cap, failure isolation, team span
    channel.ts                    ← TeamChannel: postEvent / readRecentEvents over existing seams
    default.ts                    ← createDefaultTeamCoordinator(logger, sessionManager)
  realtime/protocol.ts            ← + { type: "team_event"; event: TeamEvent }
  realtime/bus.ts                 ← + publishTeamEvent(channelId, event)
  observability/tracing.ts        ← + AgentTracer.team(); + teamRunId/parentSpanId on session trace
  observability/braintrust.ts     ← + team() span; child sessions link via parentSpanId
  routes/team.ts                  ← POST /channels/:cid/team-runs, GET /channels/:cid/team-events
  env.ts                          ← + TeamEnv { maxConcurrency } from TEAM_MAX_CONCURRENCY
  app.ts                          ← register teamRoutes({ coordinator })
```

### 1. Team channel protocol (`@reload/shared`)

Plain TS (the package forbids runtime deps). A team event is serialized into a message body using a
marker-prefixed JSON envelope so the same wire format is produced by the server and parsed back from
the channel.

```ts
export type TeamEventKind = "started" | "milestone" | "blocked" | "needs_handoff" | "done";

export interface TeamEvent {
  teamRunId: string;      // groups all events of one team run
  subtaskId: string;      // which subtask/branch this is about
  agentMemberId: string;  // who posted it
  kind: TeamEventKind;
  summary: string;        // human-readable one-liner
  branch: string | null;  // the branch the agent works on (null before assigned)
  createdAt: string;      // ISO 8601
}

export const TEAM_EVENT_MARKER = "::team-event::";
export function encodeTeamEvent(event: TeamEvent): string;        // `${MARKER} ${json}`
export function tryParseTeamEvent(body: string): TeamEvent | null; // null for non-team messages
```

`tryParseTeamEvent` is total (never throws), validates `kind`, and returns `null` for any message
that is not a well-formed team event — so a channel full of ordinary chatter parses cleanly.

### 2. TeamChannel (`src/team/channel.ts`)

Thin wrapper over the existing `ChannelPoster` + realtime bus + `listChannelMessages`.

```ts
export interface TeamChannelDeps {
  poster: ChannelPoster;                                   // reused from runtime/manager
  publish: (channelId: string, event: TeamEvent) => void;  // publishTeamEvent, best-effort
  listMessages: (channelId: string) => Promise<{ body: string }[]>; // listChannelMessages
}

class TeamChannel {
  postEvent(input: { workspaceId; channelId; event: TeamEvent }): Promise<void>; // encode → post → publish
  readRecentEvents(channelId: string, opts?: { limit?: number }): Promise<TeamEvent[]>;
}
```

`postEvent` persists via the poster (REST source of truth) and best-effort publishes on the bus —
a Redis hiccup never fails the run. `readRecentEvents` lists channel messages and parses team-event
bodies; this is how a peer reads recent events before acting.

### 3. TeamCoordinator (`src/team/coordinator.ts`)

```ts
export interface TeamLauncher {                  // SessionManager satisfies this
  launch(input: LaunchInput): Promise<{ id: string }>;
  join(id: string): Promise<void>;
}

export interface Subtask { agentMemberId: string; task: string; branch: string; subtaskId: string; }

export interface TeamRunInput {
  workspaceId: string; channelId: string; createdByMemberId: string;
  teamRunId: string; subtasks: Subtask[];
}

export interface SubtaskResult { subtaskId: string; sessionId: string | null; ok: boolean; error?: string; }

class TeamCoordinator {
  constructor(deps: { launcher: TeamLauncher; channel: TeamChannel; tracer?: AgentTracer;
                      maxConcurrency: number; logger: SessionLogger });
  runTeam(input: TeamRunInput): Promise<{ teamRunId: string; results: SubtaskResult[] }>;
}
```

- **Concurrency cap:** an async semaphore keeps ≤ `maxConcurrency` sessions in flight: launch a
  subtask, post its `started` team event, `join` it, post `done` (or `blocked` on failure), then
  pull the next subtask. `maxConcurrency` comes from `TeamEnv` (`TEAM_MAX_CONCURRENCY`, default 3).
  Per-session caps still flow through the underlying `SessionManager` unchanged.
- **Failure isolation:** each subtask runs in its own `try/catch` (allSettled semantics). One
  subtask throwing posts a `blocked` event and records `{ ok: false }` — the others run to
  completion. `runTeam` never rejects; it returns a per-subtask result array.
- **Team span:** the whole run is wrapped in `tracer.team(...)`, which stays open while children
  run (the coordinator awaits every `join`). `teamRunId` + the team span id are threaded into each
  child session's trace so Braintrust links them under one rollup.

`runTeam` is launched fire-and-forget from the route (like `SessionManager.launch`) so the HTTP
caller gets a `202` immediately; the integration test and demo await completion via polling.

### 4. Observability (`tracing.ts` + `braintrust.ts`)

Extend the tracer seam minimally and backward-compatibly:

```ts
export interface TeamTrace { teamRunId: string; workspaceId: string; channelId: string; subtaskCount: number; }
export interface TeamOutcome { completed: number; failed: number; }
export interface TeamSpanContext { parentSpanId?: string; }

export interface AgentTracer {
  session(trace: AgentSessionTrace, run: () => Promise<AgentSessionOutcome>): Promise<AgentSessionOutcome>;
  team?(trace: TeamTrace, run: (ctx: TeamSpanContext) => Promise<TeamOutcome>): Promise<TeamOutcome>;
}
```

`AgentSessionTrace` gains optional `teamRunId?` and `parentSpanId?`. `noopTracer.team` just calls
`run({})` — **zero network** when the key is unset. The Braintrust `team()` opens a parent span,
exports its id into `ctx.parentSpanId`; the coordinator threads it into each child launch's session
trace, and `session()` attaches as a child of that parent (`traced(..., { parent })`). Children also
log `teamRunId` in metadata so a run is filterable as one team.

### 5. Routes (`src/routes/team.ts`)

- `POST /channels/:cid/team-runs` — body `{ subtasks: [{ agentMemberId, task, branch }] }`. Requires
  `write` on the channel; validates each `agentMemberId` is an `agent` member of this workspace
  (IDOR), grants each agent channel write + membership (same as agent-sessions), generates a
  `teamRunId` + per-subtask `subtaskId`, fires `coordinator.runTeam(...)`, returns `202 { teamRunId }`.
- `GET /channels/:cid/team-events` — requires `read`; returns `coordinator`'s parsed recent events.

Registered in `app.ts`: `app.register(teamRoutes, { coordinator })`, coordinator built by
`createDefaultTeamCoordinator(app.log, sessionManager)` (reuses the same SessionManager instance).

### 6. Demo (`scripts/demos/26-team-mode.sh` + `apps/server/scripts/team-harness-demo.sh`)

- Boots the server with `AGENT_RUNTIME=local` and the team harness.
- The team harness, per agent, operates inside a **self-contained scratch git repo in `/tmp`**:
  creates its branch from `main`, writes to a **distinct file** (`AGENT_SUBTASK_FILE`), emits
  `started`/`milestone`/`done` team-event marker lines on stdout, commits.
- The Coordinator parses those marker lines from the streamed output into structured team events on
  the channel; the demo logs the event stream.
- Finishes by `git merge`-ing all 3 branches into `main` and asserting **no conflicts** → green.

Deterministic and side-effect-free (scratch repo is created under `mktemp -d` and removed on exit).

## Testing

- **Unit — coordinator** (`test/unit/team-coordinator.test.ts`), fake `TeamLauncher`, no DB:
  - never exceeds `maxConcurrency` (records max concurrent in-flight launches).
  - failure isolation: 1 of 3 launches throws → the other 2 complete, a `blocked` event is posted,
    `runTeam` resolves with `ok:false` for the failed subtask only.
- **Unit — protocol** (`test/unit/team-protocol.test.ts`): `encode`/`tryParse` round-trip; rejects
  non-team messages; rejects an unknown `kind`.
- **Integration** (`test/integration/team-mode.test.ts`): build app with a Coordinator over
  `LocalRuntime` + real `dbStore`/`channelPoster`; create a channel + 3 agent members; POST a
  team-run with 3 subtasks; poll until all 3 sessions complete; assert all 3 `started`+`done` team
  events landed in the channel. Uses the isolated-DB id/slug trick + `afterAll` cleanup.
- **Demo** green; all gates from `platform/`: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## Risks / decisions

- **Linking child spans:** done via Braintrust `parent` span id threaded through the trace, not via
  async-context nesting (the coordinator awaits joins, keeping the parent span open). The no-network
  guarantee is unit-tested through `noopTracer`.
- **Reading peers:** REST is the source of truth (no event store), so `readRecentEvents` reads
  channel messages. This matches the existing realtime design exactly.
- **Branch conflicts:** the demo guarantees mergeability by assigning each agent a distinct file;
  the design does not attempt automatic semantic conflict resolution (out of scope).
