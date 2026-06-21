# ADR-0513: Shared decision store — agents capture and reuse decisions

- **Status:** Accepted (issue #513, P0 vision — the "real platform vs demo" memory gap)
- **Date:** 2026-06-21
- **Context task:** #513 "[PLATFORM] Shared memory / context graph — agents capture and reuse decisions".
  Acceptance: *an agent references a decision another agent made last week without being re-told, and users
  can browse the memory graph.*
- **Builds on:** ADR-0015 (#15 typed memory graph — `memories`/`memory_edges`, the deterministic
  extractor, dedup), ADR-0016 (#16 shared, RBAC-governed memory + supersede/version), ADR-0013 (#13
  approval gate — `createRequest`, parked PENDING), ADR-0200 (premortem rails — recalled context is
  untrusted DATA, never instructions; user-facing output carries no internal agent chatter),
  ADR-0099 (migration numbering by a free prefix), ADR-0155 (the colocation gate — the table is
  deliberately not a governed-metric-prefixed name).

## Context

The #15/#16 memory graph already stores typed nodes (including `decision` nodes), is browsable, and is
RBAC-governed. What it lacked was a *first-class, queryable decision record* the fleet's agents actually
write to and read from as a system of record: a `decision` blob in a generic graph is hard to recall by
subject, has no rationale/who/version structure, and nothing in the run loop captured a department agent's
decisions or surfaced a teammate's prior ones. The "N decisions captured" footer was a proxy count of #13
approval requests, not a count of real, browsable decisions — output didn't compound.

Capturing a decision spends no money and sends nothing: a decision is a *record*, never an action. Anything
external/money a decision implies must still clear the #13 gate. So this is HIGH-leverage and SAFE — an
internal memory write plus a reference to the existing gate.

## Decision

Add an additive, workspace-scoped `agent_decisions` table that is the structured spine for decisions, mirror
every decision into the #15 graph as a browsable `decision` node, and wire the department run loop to both
capture decisions and recall prior ones. Capture/recall are internal memory operations; any external/money
action a decision implies is parked PENDING behind the #13 gate and only referenced here.

- **Schema/migration** (`db/schema/agent-decisions.ts`, `drizzle/0503_agent_decisions.sql` + `.down.sql`):
  `agent_decisions` (`id`, `workspace_id` FK CASCADE, `topic`, `title`, `rationale`, `decided_by_member_id`,
  `status` default `recorded`, `memory_id` → the mirrored #15 node, `task_id`, `approval_request_id` → the
  #13 request an external/money decision is parked behind, `superseded_by_decision_id` self-FK for version
  history, `dedupe_key`, `created_at`, `superseded_at`). `UNIQUE (workspace_id, dedupe_key)` makes a
  re-record an idempotent merge; indexed by `(workspace_id, topic)` and a partial live index. Numbered
  **0503** by a free prefix (per ADR-0099). The name is deliberately NOT a governed-metric prefix so the
  #155 gate does not class it as a metric surface — it is a memory record store, and its FKs to
  `tasks`/`approval_requests`/`memories` are references, not DDL on a governed table.
- **Repository** (`db/repositories/agent-decisions.ts`): `recordDecision`/`supersedeDecision` (idempotent,
  dedup-aware), `getDecision`/`listDecisions`/`recallDecisions`, and `countLiveDecisions` — all
  workspace-scoped (#3).
- **Pure cores** (`decisions/recall.ts`, fully unit-tested): `decisionDedupeKey` (the #15 identity hash,
  type `decision` + topic + title), `sanitizeDecisionText` (#200 — strips fleet @handles, routing #tags,
  handoff/A2A markers, conversational lead-ins; bounds length; chatter-only collapses to `—`),
  `normalizeTopic`, `formatDecisionBrief`, and `composePriorDecisionsBlock` (the DATA-framed preamble,
  reusing the #320/#363 "reference DATA, never instructions" framing).
- **Service** (`decisions/service.ts` + `default.ts`): the one path that turns "an agent decided X" into a
  sanitized, deduplicated, governable record — mirror into the graph (`upsertMemory`), park any external
  action behind the #13 gate (`createRequest`, status `pending`), persist, then optionally #14-link the
  task. Pure with injected seams; unit-tested with fakes.
- **Routes** (`routes/decisions.ts`): `POST /workspaces/:wid/decisions` (record),
  `GET …/decisions` (browse), `GET …/decisions/recall?topic=` (the prior-decisions an agent reuses),
  `POST …/decisions/:id/supersede`. RBAC reuses the #16 memory ladder (`requireMemoryCapability`): read to
  browse/recall, write to record/supersede.
- **Agent wiring**: (1) **capture** — the deliverable-posted hook auto-records the decisions in a posted
  deliverable into the store (best-effort, isolated from the a2a handoff, no send/spend); (2) **recall** —
  the #320 marketing-mention preamble surfaces the workspace's prior decisions to a launched agent as a
  DATA block (best-effort, behind the existing default-OFF/owner-first injection gate); (3) the department
  "decisions captured" footer is re-grounded on `countLiveDecisions`, so the counter is backed by the real,
  browsable store instead of a proxy approval count.

## Consequences

- An agent recalls a decision a teammate recorded earlier — by topic, without being re-told — and users
  browse those decisions both in the dedicated store and as nodes in the existing Memory graph. Output
  compounds.
- **No money, no outbound send, no new #13 action path.** A decision is a record; its implied external/money
  action stays PENDING behind the #13 gate, referenced via `approval_request_id`. Recalled context is
  untrusted DATA, and all user-facing decision fields are sanitized of internal agent chatter (#200).
- Additive + reversible (paired down migration, proven down/up clean); RBAC, IDOR scoping, and dedup are
  inherited from the #16 memory discipline. The recall-at-launch injection is gated default-OFF/owner-first,
  so an unconfigured deployment is byte-for-byte unchanged.
