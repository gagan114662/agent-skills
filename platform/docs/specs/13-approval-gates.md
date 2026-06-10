# Spec: Reload Platform — Human Approval Gates & Governance (Issue #13)

> Implements [#13](https://github.com/gagan114662/agent-skills/issues/13). Phase 2 — Agent integration. Depends on #9 (RBAC ladder / IDOR discipline / `permissions`), #8 (notifications — the `approval` type is already reserved), #4/#5 (channels/messages/realtime — the concrete executor reuses them).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0008](../adrs/0008-notifications.md), [ADR-0009](../adrs/0009-registry-rbac.md), [ADR-0014](../adrs/0014-tasks.md) (the event-sourced-audit + single-access-helper pattern). No code until approved → PLAN → BUILD (TDD) → demo → PR (no merge without approval).
>
> This issue ships the **smallest vertical slice of EPIC [#20](https://github.com/gagan114662/agent-skills/issues/20)** that realises the headline vision — *"humans only on critical decisions"* — end to end. Sibling agent-integration issues (#10 MCP, #12 ACP/A2A, #17 autonomy) are deferred and tracked on #20.

## Objective
**What:** A governance layer so an agent's **sensitive action** does not execute silently — it **pauses as a pending approval request** that a human approves or rejects. On **approve**, the action **executes** (with the requester's identity and capabilities); on **reject**, it is **blocked**; if no human decides within a TTL, it **expires** and never executes. Every request and every decision is captured in an **append-only audit log**.

**Why:** Phase 2 makes agents first-class actors (registry #9, REST/CLI #11, sessions #25). The agent-first product only works if a human can stay *out* of the loop for routine work yet *in* the loop for the few actions that matter — external sends, spend over a threshold, or anything a workspace marks sensitive. This is the keystone that makes autonomous agents (#17) safe to ship.

**Who:** Any **member** can submit an action (agents via Bearer token, humans via session cookie). Only **human** members may decide an approval request — *"humans only on critical decisions"*. Both are `members` (#3), so the requester/decider are interchangeable identities over one model (ADR-0002 §5).

## The model

### Sensitive actions & the policy engine
An **action** is `{ actionType, payload, amount? }`. Whether it needs approval is decided by a **pure policy function** over the workspace's **policy rules** (no free-form gating):

```
evaluatePolicy({ actionType, amount }, rules) → { requiresApproval, reason }
```

- A **rule** is `{ actionType, requiresApproval, maxAutoAmount }`.
- If a rule matches the action type: `requiresApproval=true` ⇒ gated; otherwise the action is auto-approved **unless** `amount` exceeds `maxAutoAmount` (the spend gate), which re-gates it.
- With **no matching rule**, the action is gated iff its type is in `DEFAULT_SENSITIVE_ACTIONS` (`external.send` ships gated by default — "external sends require approval"). Everything else proceeds.

The function is total, dependency-free, and unit-tested; it is the single source of truth for *"does this action pause?"*.

### Action types & the executor registry
The action a request stands for is run by a small **executor registry** (`actionType → executor`). Two ship:

| actionType | side effect | gated by default |
|---|---|---|
| `chat.post_message` | posts a message to a channel (reuses #4 `postMessage` + #5 realtime), as the requester | no (add a rule to gate) |
| `external.send` | an outbound send — **recorded only** (no real network egress), returns `{ recorded: true }` | **yes** |

Each executor declares a **payload validator** (pure) so a malformed action is a `400` at submit time, never a deferred failure. The registry lookup + validators are unit-tested with a fake executor; the concrete `chat.post_message` side effect is exercised in integration.

> **Disclosure — `external.send` is recorded-only, by design.** Approving an `external.send` records
> the intent and returns `{ recorded: true }`; the platform makes **no** outbound network call on the
> user's behalf. This is intentional and permanent (it keeps CI/tests egress-free and avoids the
> platform becoming an open relay), not a stubbed TODO. To perform real egress, register your own
> executor for a dedicated action type that calls your delivery service — it inherits the same gate.

### Request lifecycle
```
              submit action
                   │
        evaluatePolicy(rules)
            │                │
   requiresApproval     auto-approve
            │                │
        pending          execute now → { status: executed }
       ╱    │    ╲
  approve reject  (ttl elapses)
     │      │        │
  execute  rejected expired
   │   ╲
executed failed        (executor threw)
```

- **Statuses:** `pending → {executed, failed}` (approve path), `pending → rejected` (reject path), `pending → expired` (TTL). `executed`/`failed`/`rejected`/`expired` are terminal.
- **Expiry is lazy + sweepable:** a decision on a due request first marks it `expired` (a `409`, never an execution); a `sweep-expired` endpoint marks all due pending requests in bulk. `isExpired(expiresAt, now)` is pure and unit-tested.
- **Approve is a guarded transition:** an atomic `pending → approved` (conditional UPDATE) prevents a double-approve race; only the winner executes. Execution result (or error) is recorded and the row moves to `executed`/`failed`.

### Audit log (append-only)
Every transition appends an immutable `approval_events` row (`requested`, `approved`, `rejected`, `expired`, `executed`, `failed`) carrying actor, an optional `detail` blob, and a timestamp — the same event-sourced discipline as #14's `task_events`. State can never drift from the log because the event is written in the **same transaction** as the mutation. The log is queryable per request.

## Surface (REST)
| Endpoint | Who | Purpose |
|---|---|---|
| `POST /workspaces/:wid/approval-policies` | human, `propagate` on workspace | upsert a policy rule `{ actionType, requiresApproval?, maxAutoAmount? }` |
| `GET /workspaces/:wid/approval-policies` | workspace member | list rules |
| `DELETE /workspaces/:wid/approval-policies/:ruleId` | human, `propagate` | remove a rule |
| `POST /workspaces/:wid/actions` | workspace member | submit an action; `202 {status:'pending', request}` or `200 {status:'executed', result}` |
| `GET /workspaces/:wid/approvals?status=` | workspace member | list approval requests (review queue) |
| `GET /approvals/:rid` | workspace member | one request + preview |
| `GET /approvals/:rid/events` | workspace member | audit trail |
| `POST /approvals/:rid/approve` | **human** member | approve → execute; `200 {status:'executed'|'failed'}` |
| `POST /approvals/:rid/reject` | **human** member | reject (with `reason`) → blocked |
| `POST /workspaces/:wid/approvals/sweep-expired` | human, `propagate` | expire all due pending requests |

A new **pending** request fires an `approval` notification (#8) to every other human member (the reviewers). Realtime/inbox surfacing reuses the existing transport — no new fan-out.

## Acceptance (BUILD — TDD)
- [ ] A sensitive agent action → **pending** approval, **not executed** (no message posted yet).
- [ ] **Approve executes** the action (message appears / `external.send` recorded); **reject blocks** it (terminal, no side effect).
- [ ] Requests + decisions are **auditable** (`approval_events` chain: requested → approved → executed, etc.).
- [ ] **Approve / reject / expiry** are tested, including a double-decision `409` and an expired request that can't be approved.
- [ ] **Only humans decide** (an agent's approve/reject is `403`); cross-workspace request access/decision is `404`/`403` (IDOR).
- [ ] An action with **no rule + non-sensitive type** auto-executes; `external.send` is gated by default.

## Out of scope (deferred)
- A dedicated **web approvals panel** (the #18 web client surface) — backend + shared contract ship here; the panel is a follow-up.
- Richer executors (real outbound email/webhook egress, task mutations, memory writes), **per-request reviewer assignment**, **multi-approver quorum**, and **deep-link** notification payloads (the inbox carries a summary excerpt only).
- The autonomous loop that *generates* these requests at scale (#17) and the MCP/ACP surfaces that submit them (#10/#12).
