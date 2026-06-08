# Spec: Reload Platform — Human approval gates & governance for sensitive actions (Issue #13)

> Implements [#13](https://github.com/gagan114662/agent-skills/issues/13). Phase 2 — Agent integration. Depends on #9 (RBAC), #8 (notifications); builds on #3 (auth/identity), #4 (channels), #5 (realtime), #25 (agent sessions).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Pre-approved by Gagan for end-to-end execution through PR (no merge without review + video).

## Objective
**What:** A **governance layer** that pauses an agent's **sensitive action** for **human approval**
before it executes. An agent (or any member) submits an **approval request** describing the action
it wants to take (a **preview**: a kind, a human-readable summary, and a structured descriptor). A
**policy engine** decides whether that action needs a human in the loop. If it does, the request is
recorded as **`pending`** and the action **does not execute** — humans in the workspace are notified
(reusing the #8 `approval` notification type). A **human** then **approves** (the action executes)
or **rejects** with a reason (the action is **blocked**). Every request and every decision is
written to a durable, **queryable audit log**. Requests carry a **TTL** and **expire** if no human
acts in time — an expired request can never be approved.

**Why:** #25 made agents long-lived and server-owned ("close the laptop, agents keep working"). The
moment agents act autonomously, some actions are too consequential to run unattended — spending
money, sending data to an external system, or posting into a guarded channel. reload.chat's answer
is "humans only on critical decisions": let agents move fast on the safe majority, and gate the
critical minority behind a human approval workflow with a full audit trail. #8 already **reserved**
the `approval` notification type for exactly this primitive; #13 is the trigger that emits it.

**Who:** Agents (Bearer token) are the primary **requesters** — they ask before doing. Humans
(session cookie) are the **approvers** — only a `human` member may approve or reject (the core
"humans on critical decisions" rule). Both are `members`; both can read the audit log within their
workspace. Governance **policy** is human-configured (read by anyone, written by humans).

### Acceptance criteria (from #13)
- **Sensitive agent action → pending approval (not executed).** A request the policy deems
  sensitive is recorded `pending`; the executor is **not** invoked; humans are notified.
- **Approve executes; reject blocks.** Approving a pending request runs the gated action exactly
  once and records its outcome; rejecting records the reason and the action never runs.
- **Requests/decisions auditable.** Every request, its policy reason, its decision (who/when/why),
  and its execution outcome are persisted and queryable (by status / requester).
- **approve / reject / expiry tested.** A pending request past its TTL is `expired` and can no
  longer be approved or rejected; the state machine forbids re-deciding a terminal request.
- Policy covers **action types, channels, spend, and external sends** (the four levers in #13).
- Everything stays **workspace-scoped** (#3 IDOR) and respects **#9**; an `approval` notification
  rides the existing #8 path (no protocol break).

### Out of scope (deferred — noted in ADR-0013 and the PR)
- **Web UI (apps/web).** A human-facing approvals inbox / approve-reject panel. The server API,
  realtime notification, and OpenAPI contract ship now; the React surface is a fast follow.
- **CLI verb (`reload approve`).** The agent CLI (#11) gains an approvals verb later.
- **Background expiry sweeper (cron).** Expiry is enforced **lazily** on access (an approve/reject
  on an overdue request returns `expired` and finalizes the row), and a pure `sweepExpired` helper
  exists; a scheduled job that bulk-expires idle rows is future work.
- **Per-action-type granular policy / approver quorums / delegation.** One workspace policy with
  four levers; multi-approver and per-resource policies are future work.
- **Automatic interception of #25 session side-effects.** #13 ships the approval *primitive* an
  agent calls before a sensitive step; auto-wrapping every runtime egress is future work.

## Policy engine — what needs approval
A pure, unit-tested module (`governance/policy.ts`) classifies an action against the workspace
policy. It is the single source of truth for "does this need a human?" and mirrors the
`notifications/types.ts` / `tasks/status.ts` pure-logic pattern.

An **action** is `{ kind, summary, amountCents?, currency?, channelId?, destination?, metadata? }`:
- `external_send` — sending data/messages outside the platform (email, webhook, third-party API).
- `spend` — spending money (`amountCents`).
- `channel_post` — posting into a specific channel (`channelId`).
- `custom` — anything else an integration wants to gate by name.

The **policy** (`governance_policies`, one row per workspace, defaults when absent):
- `externalSendRequiresApproval` (default **true**) — every `external_send` needs approval.
- `spendThresholdCents` (default **0**) — a `spend` with `amountCents > threshold` needs approval
  (default 0 ⇒ any positive spend is gated).
- `guardedChannelIds` (default `[]`) — a `channel_post` into one of these channels needs approval.
- `requireApprovalFor` (default `[]`) — action kinds that **always** need approval, regardless.
- `defaultTtlMs` (default **86_400_000** = 24h) — TTL applied to a new pending request.

`evaluatePolicy(action, policy) → { required, reason }`. `reason` is a short, audit-friendly string
(e.g. `"external send requires approval"`, `"spend 5000 > threshold 0"`, `"channel <id> is
guarded"`, `"kind 'custom' always requires approval"`, or `"auto: policy allows"`).

## Request lifecycle & state machine
`pending → approved | rejected | expired`, plus the create-time terminal `auto_approved`.

- **Request** (`POST /workspaces/:wid/approvals`): the service evaluates policy.
  - **Not required** → row is created `auto_approved`, the executor runs immediately, `executedAt`
    + `outcome` are set. (Still audited — you can see what agents did even when no gate fired.)
  - **Required** → row is created `pending` with `expiresAt = now + defaultTtlMs`; the executor is
    **not** run; humans are notified (`approval`).
- **Approve** (`POST /workspaces/:wid/approvals/:id/approve`, **human-only**): if the row is past
  `expiresAt` it is finalized `expired` and the call returns `409 expired`. Otherwise the row moves
  `pending → approved` (atomic, conditional on still-`pending` — the audit-integrity guard against a
  double decision / TOCTOU race), the executor runs **once**, and `outcome` + `executedAt` are set.
- **Reject** (`POST /workspaces/:wid/approvals/:id/reject`, **human-only**, `reason` required):
  same expiry check, then `pending → rejected` with the reason; the executor never runs.
- A terminal request (`approved` / `rejected` / `expired` / `auto_approved`) can never be
  re-decided — the conditional update matches only `pending`, so a second decision returns
  `409 already decided`.

## Execution seam
The service drives an injectable **`ApprovalExecutor`** — the gate is generic over *what* the action
does. The default executor makes the authorization observable in-product: if the action names a
`channelId`, it posts a confirmation message into that channel **as the requester** (reusing the #5
publish-on-write path), and records the message id as the `outcome`; otherwise it records
`outcome = "authorized"`. Failures are best-effort (the decision is the governance act; downstream
execution is recorded, not transactional). Tests inject a fake executor to assert it runs exactly
once on approve and never on reject/pending.

## Audit log
The `approval_requests` table **is** the audit log: requester, action kind + summary + descriptor,
policy reason, status, decider, decision reason, outcome, and the `createdAt / decidedAt /
executedAt / expiresAt` timeline. Queryable via `GET /workspaces/:wid/approvals?status=&requestedBy=`
(any member, workspace-scoped) and `GET /workspaces/:wid/approvals/:id`. Decisions are append-only
in effect (terminal rows are immutable) so the trail cannot be rewritten.

## API surface
All routes are workspace-scoped (#3 IDOR via `assertWorkspace`); approve/reject/policy-write are
human-only (`identity.kind === "human"`, the #9 + reload "humans on critical decisions" rule).

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/workspaces/:wid/approvals` | any member | Request approval for an action (preview). |
| GET | `/workspaces/:wid/approvals` | any member | Audit list (`?status=`, `?requestedBy=`). |
| GET | `/workspaces/:wid/approvals/:id` | any member | One request + its decision (preview/audit). |
| POST | `/workspaces/:wid/approvals/:id/approve` | human | Approve → execute. Body `{ reason? }`. |
| POST | `/workspaces/:wid/approvals/:id/reject` | human | Reject → block. Body `{ reason }`. |
| GET | `/workspaces/:wid/governance-policy` | any member | Read the policy (defaults if unset). |
| PUT | `/workspaces/:wid/governance-policy` | human | Upsert the policy (partial patch). |

`POST /workspaces/:wid/approvals` (request) and the two GETs are added to the published #11 OpenAPI
contract so external agents can integrate against the gate.

## Data model
**`approval_requests`** — one row per requested action (the audit record):
`id`, `workspace_id` (→ workspaces, cascade), `requested_by_member_id` (→ members, cascade),
`action_kind`, `action_summary`, `action` (jsonb descriptor), `channel_id` (→ channels, set null;
denormalized for scope/preview), `status` (`pending|approved|rejected|expired|auto_approved`),
`policy_reason`, `decided_by_member_id` (→ members, set null), `decision_reason`, `outcome`,
`created_at`, `decided_at`, `executed_at`, `expires_at`. Indexed by `(workspace_id, status,
created_at)` for the audit query and by `requested_by_member_id`. CHECK constraints pin the
`status` and `action_kind` enums.

**`governance_policies`** — one row per workspace (natural key `workspace_id`):
`spend_threshold_cents`, `external_send_requires_approval`, `require_approval_for` (jsonb),
`guarded_channel_ids` (jsonb), `default_ttl_ms`, `updated_at`.

Migration `0013_approval_gates.sql` (+ `.down.sql`), additive — no existing table is touched.

## Security considerations (security-critical per #13)
- **No bypass path.** Only a `pending` request can be approved/rejected, via an atomic
  conditional update; agents (`kind !== "human"`) are rejected with 403 at approve/reject; the
  requester cannot self-approve simply because approval is human-only and the act is recorded with
  the decider's id.
- **Audit integrity.** Terminal rows are immutable (the conditional update never matches them); the
  decider, reason, and timestamps are server-stamped, not client-supplied.
- **Tenant isolation.** Every read/write is workspace-scoped; a request id from another workspace
  is a 404, never readable or decidable (the #3 IDOR discipline, covered by the cross-tenant test).
- **Expiry can't be skipped.** An overdue `pending` request is finalized `expired` on the next
  approve/reject and refuses the decision.
- **Best-effort side-effects never fail the gate.** Notification and executor errors are logged,
  not propagated — the governance decision is the source of truth.

## Testing strategy
- **Unit (no DB/Redis):** `policy.test.ts` — every policy lever + reason strings + defaults +
  `isExpired` + `canResolve`/terminal set. `service.test.ts` — request auto-approves vs. pends;
  approve runs the executor exactly once and records outcome; reject never runs it; expiry returns
  `expired` and finalizes; re-deciding a terminal request returns `already_decided`. Fakes for
  store/executor/notifier/clock.
- **Integration (real Postgres + Redis):** `approvals.test.ts` — an agent requests an
  `external_send` → `pending`, no channel message; a human approves → channel message appears +
  status `approved` + `executedAt`; a separate request rejected → blocked, reason recorded; a
  below-threshold spend `auto_approved` immediately; expiry (past `expires_at`) → `409 expired`;
  an agent approving → 403; cross-workspace request id → 404; the audit list filters by status.
