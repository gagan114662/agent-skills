# ADR-0013: Human approval gates & governance for sensitive agent actions

- **Status:** Accepted (defaults chosen — issue #13)
- **Date:** 2026-06-08
- **Context issue:** [#13](https://github.com/gagan114662/agent-skills/issues/13) (vertical slice of EPIC [#20](https://github.com/gagan114662/agent-skills/issues/20))
- **Builds on:** [ADR-0008](0008-notifications.md) (notifications — the `approval` type was reserved here), [ADR-0009](0009-registry-rbac.md) (RBAC ladder + single-access-helper / IDOR pattern), [ADR-0014](0014-tasks.md) (event-sourced, append-only audit written in the mutation's transaction)

## Context
Phase 2 makes agents first-class actors (registry #9, REST/CLI #11, server-side sessions #25). The agent-first promise — *"humans only on critical decisions"* — needs a governance seam: an agent can act freely on routine work, but a **sensitive action** must pause for a human. #8 already reserved an `approval` notification type for exactly this primitive; this issue implements it. It is the keystone that makes the autonomous loop (#17) safe to enable later.

## Decisions
1. **One submission seam, `POST /workspaces/:wid/actions`, gated by a pure policy function.** Members never call executors directly; they submit an action `{ actionType, payload, amount? }` and the server decides. `evaluatePolicy(action, rules)` is total, dependency-free, and unit-tested — the single source of truth for *"does this pause?"*. A rule `{ actionType, requiresApproval, maxAutoAmount }` gates by type and/or by a spend threshold; with no matching rule, gating falls back to `DEFAULT_SENSITIVE_ACTIONS` (`external.send` ships gated — "external sends require approval"). This keeps the gating decision in one tested place rather than scattered across endpoints.
2. **An executor registry (`actionType → executor`) with pure payload validators, not a hardcoded switch.** Two executors ship: `chat.post_message` (real side effect — reuses #4 `postMessage` + #5 `publishMessageEvent`, run as the requester) and `external.send` (recorded-only — **no real network egress**, so CI/tests never make outbound calls). Each declares a pure validator so a malformed action is a `400` at submit time. New executors slot in without touching the routes/policy. The registry + validators are unit-tested with a fake executor; the concrete side effect is integration-tested.
3. **Execution runs with the requester's identity and is re-checked at execution time, not only at submit.** `chat.post_message` validates the channel is in-workspace and that the **requester** holds `write` on it (the #9 ladder) *when it runs*, so a capability revoked between request and approval is honoured. Approval authorises the *human decision*, not a capability bypass — the agent can never escalate by routing through an approver.
4. **Only human members decide; the requester cannot self-approve.** Deciding is restricted to `kind='human'` workspace members (a `403` for agents) — the literal reading of "humans only on critical decisions". The requester approving their own request is rejected (`403`), closing the obvious self-grant bypass. Submitting is open to any member (agents are the expected submitters).
5. **Guarded `pending → approved` transition + execute-then-record, so a double-approve can't double-execute.** Approval is an atomic conditional `UPDATE … WHERE status='pending'` that returns the row only to the winner; the loser gets a `409`. The winner executes outside the lock, then records `executed` (with the result) or `failed` (with the error). A failed execution is terminal and audited — it is **not** silently retried.
6. **Lazy + sweepable TTL expiry; `isExpired` is pure.** A request carries `expires_at = created_at + ttl` (ttl from the request or an env default). A decision on a due request first marks it `expired` (a `409`, never an execution); `POST …/approvals/sweep-expired` bulk-expires due pending requests for housekeeping. `isExpired(expiresAt, now)` is a pure unit-tested function; the deterministic integration test gates with `ttlSeconds: 0`.
7. **Append-only `approval_events` audit, written in the mutation's transaction (the #14 pattern).** Every transition (`requested`/`approved`/`rejected`/`expired`/`executed`/`failed`) appends an immutable row carrying actor + a `detail` blob. State can't drift from the log because both are one transaction; the log is queryable per request. There is **no** mutable audit column.
8. **Reuse #8 notifications for reviewer alerts — no new fan-out.** A new pending request calls `notify(... type:'approval')` for every *other* human member, reusing the existing inbox/realtime/transport path (`notify` is best-effort and never fails the write). The inbox item carries a summary `excerpt`; a deep-linking payload field is deferred.
9. **Additive `0013_approval_gates` migration with a clean down.** Three new tables (`approval_policies`, `approval_requests`, `approval_events`); no existing table is touched. Numbered `0013` (free — prior numbers are `0000`–`0007` ×2 and `0025`). The down drops all three; the CI down/up step stays green.

## Enforcement / surface map
| Endpoint | Access |
|---|---|
| `POST/DELETE …/approval-policies`, `…/approvals/sweep-expired` | human + `propagate` on the workspace memory/admin resource (`requireWorkspaceAdmin`) |
| `GET …/approval-policies`, `POST …/actions`, `GET …/approvals` | workspace member (`assertWorkspace`) |
| `GET /approvals/:rid`, `GET …/events` | `requireApprovalInWorkspace` (404 cross-workspace) |
| `POST /approvals/:rid/approve`, `…/reject` | `requireApprovalInWorkspace` + **human** + not the requester (403) |
| submit gating | `evaluatePolicy` (pure) |
| approve race / re-decide / expired | guarded transition → `409` |

## Consequences
- **Positive:** A complete, security-reviewable governance primitive — one tested gating function, an extensible executor registry, capability re-checks at execution, human-only decisions, a race-proof approve path, and an append-only audit that can't drift. Routes stay thin (one access helper + pure functions; logic in the repo), mirroring #9/#14.
- **Costs / deferred:** the **web approvals panel** (#18 surface), **real outbound egress** for `external.send`, richer executors (task/memory mutations), **multi-approver quorum / reviewer assignment**, and **deep-link** notification payloads are out of scope. The autonomous loop that generates these at scale (#17) and the MCP/ACP submitters (#10/#12) are separate #20 sub-tasks.
- **Security posture:** self-approval and agent-decision bypasses are closed; capabilities are re-validated at execution, not assumed from submit; the audit log is append-only and transactional; cross-workspace request access/decision is closed and covered by the integration IDOR test. Security-critical per #13 — wants a `security-and-hardening` pass and stays exempt from auto-merge (Gagan approves on the video).
