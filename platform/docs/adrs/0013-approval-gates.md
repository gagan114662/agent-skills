# ADR-0013: Human Approval Gates & Governance for Sensitive Agent Actions

- **Status:** Accepted (Gagan pre-approved end-to-end execution — issue #13; merge still gated on review + video)
- **Date:** 2026-06-08
- **Context issue:** [#13](https://github.com/gagan114662/agent-skills/issues/13) (Phase 2 — Agent integration)
- **Builds on:** [ADR-0003](0003-auth-identity.md), [ADR-0004](0004-channels-dms.md),
  [ADR-0008](0008-notifications.md), [ADR-0009](0009-registry-rbac.md),
  [ADR-0025](0025-cloud-execution.md)

## Context
#25 made agents long-lived and server-owned ("close the laptop, agents keep working"). The moment
an agent acts autonomously, some actions are too consequential to run unattended — spending money,
sending data to an external system, or posting into a guarded channel. reload.chat's answer is
"humans only on critical decisions": let agents move fast on the safe majority and gate the critical
minority behind a human approval workflow with a full audit trail. #8 already **reserved** the
`approval` notification type for exactly this primitive; #13 is the trigger that emits it.

## Decisions

1. **A pure policy engine is the single source of truth for "does this need a human?"**
   `governance/policy.ts` is dependency-free and unit-tested (the `notifications/types.ts` /
   `tasks/status.ts` pattern), so it runs in the no-DB/no-Redis job and behaves identically
   everywhere. It covers the four #13 levers: **external sends** (gated by default), **spend**
   (gated strictly above a threshold; default 0 ⇒ any positive spend), **guarded channels**
   (`channel_post` into a configured channel), and **always-gate kinds** (`requireApprovalFor`). The
   verdict carries an audit-friendly `reason`.

2. **Policy is per-workspace with safe defaults.** `governance_policies` holds one row per workspace
   (the four levers + a request TTL); when absent, `DEFAULT_POLICY` still gates external sends and
   any positive spend. Humans configure it (`PUT`); anyone may read it (`GET`) — including agents,
   so an agent can know in advance what will need approval.

3. **One immutable audit row per requested action, with a tight state machine.**
   `approval_requests` IS the audit log: requester, action kind + summary + descriptor, policy
   reason, status, decider, decision reason, outcome, and the `created/decided/executed/expires`
   timeline. States are `pending → approved | rejected | expired`, plus the create-time terminal
   `auto_approved`. A request is created `pending` (gated, **not** executed) or `auto_approved`
   (ungated, executed immediately) — either way it is audited, so you can see what agents did even
   when no gate fired.

4. **Resolution is an atomic, pending-only conditional update — the audit-integrity / no-bypass
   guard.** Approve/reject update the row `WHERE status = 'pending'`; a terminal row never matches,
   so a request can never be re-decided and two concurrent decisions can't both win (TOCTOU-safe).
   The decider, reason, and timestamps are server-stamped, never client-supplied.

5. **Only humans decide.** Approve/reject and policy-write require `identity.kind === "human"` (an
   agent gets 403). This is the core "humans on critical decisions" rule; an agent cannot approve
   its own (or any) request. Requesting is open to any workspace member.

6. **An injectable executor seam makes the gate generic, and the authorization observable.** The
   service drives an `ApprovalExecutor`; the default posts a confirmation into the action's channel
   **as the requester** (reusing the #5 publish-on-write path) and records the message id as the
   `outcome`, or records `authorized` when there is no channel. Execution is best-effort — the
   decision is the governance act; a downstream failure is recorded, never propagated, and never
   turns an approved action back into a pending one. The deps-injected `ApprovalService` (store /
   executor / notifier / clock) mirrors the #25 SessionManager shape, so the whole flow is
   unit-testable with no DB/Redis.

7. **Pending requests notify humans over the existing #8 path.** On a pending request the service
   fans an `approval` notification out to every human in the workspace (except the requester) via
   the #8 `notify()` seam — durable inbox + live `notification` event, no realtime protocol change.

8. **Expiry is enforced lazily; a sweeper is deferred.** A pending request carries
   `expires_at = now + defaultTtlMs`. On the next approve/reject of an overdue request the row is
   finalized `expired` and the decision is refused (`409`). A pure `isExpired` helper backs this; a
   scheduled bulk-expiry job is future work (so we ship no cron and no background timer now).

## Consequences
- Sensitive agent actions pause for a human; approve executes exactly once, reject blocks — proven
  by the integration suite (a channel message appears on approve, never on reject).
- Every request + decision is a durable, queryable, tamper-resistant audit row.
- Governance is configurable per workspace with secure-by-default behavior for unconfigured ones.
- The `approval` notification type reserved in #8 now has a real trigger.

## Security review (security-critical per #13)
- **No bypass path:** only `pending` rows resolve, via an atomic conditional update; non-humans are
  rejected; the decider id is recorded by the server.
- **Audit integrity:** terminal rows are immutable; decision metadata is server-stamped.
- **Tenant isolation:** every read/write is workspace-scoped (#3 IDOR) — a cross-workspace request
  id is a 404/403, never readable or decidable (covered by a test).
- **Expiry can't be skipped:** an overdue pending request is finalized `expired` and refuses the
  decision.
- **Best-effort side-effects never fail the gate:** notifier/executor errors are recorded/logged,
  not propagated.

## Alternatives considered
- **Auto-intercept every #25 runtime egress.** Rejected for this slice: it couples the gate to the
  sandbox internals and a fixed taxonomy. #13 ships the *primitive* an agent calls before a
  sensitive step; transparent interception is a later layer that can reuse this engine.
- **Approve via channel reaction / message command.** Rejected: a typed REST decision with a
  server-stamped decider is auditable and unambiguous; a chat-command UX can be layered on later.
- **A separate `approval_decisions` table.** Rejected: one row with a terminal-immutability
  invariant is simpler and is itself the audit trail; a separate event log is future work if
  multi-step decisions (delegation, quorum) arrive.

## Follow-ups (deferred — tracked in the PR)
- **Web UI (apps/web):** a human approvals inbox + approve/reject panel.
- **CLI verb (`reload approve`)** for the #11 agent CLI.
- **Background expiry sweeper** (scheduled bulk-expire of idle pending rows).
- **Per-action-type policies, approver quorums, delegation.**
- **Transparent interception** of #25 session side-effects through this engine.
