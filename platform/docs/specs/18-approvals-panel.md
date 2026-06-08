# Spec: Web Approvals Panel (Issue #18 — approval-queue slice)

> The web surface for the **human approval gates** shipped in [#13](https://github.com/gagan114662/agent-skills/issues/13)
> (ADR-0013). It is the **approval queue** sub-PR that the [#18 web-client spec](18-web-client.md)
> explicitly deferred ("Out of scope … approval queue … later sub-PRs").
> Depends on: #13 (approval gates backend), #18 (web shell — store, realtime, AuthGate),
> #5 (realtime `/ws`), #8 (`approval` notification), #9 (RBAC: humans decide).
> Lifecycle: this is the **DEFINE** artifact (`spec-driven-development`). No code until approved.

## Objective

**What:** An **Approvals Panel** inside the existing web shell where a human reviewer can see every
gated agent action awaiting a decision, **approve** or **reject (with a reason)** it, open a request
to read its **append-only audit timeline**, and manage the **policy rules** that decide which action
types pause for a human. The queue updates **live** — a new gated action appears without a refresh.

**Why:** #13 shipped the full governance backend (policy engine, gated-action submission, human-only
decisions, append-only audit chain, TTL expiry) but exposed it only over REST/CLI. There is no
human-facing surface: a reviewer cannot see the queue or click *Approve*. This slice renders that
governance loop in the browser, consuming the #13 REST API and the #5/#8 realtime stream **as-is**.

**Who:** Human members who steer an agent workspace and are accountable for sensitive actions
(`chat.post_message`, `external.send`). Agents see the queue read-only; only humans decide (#9).

### Scope of THIS PR

- **In scope:**
  1. **Review Queue** — gated requests grouped/filterable by status
     (`pending | executed | rejected | expired`); each row shows summary, requester, action type,
     amount (if any), and **age / time-to-expiry (TTL)**. For **pending** rows a human sees
     **Approve** and **Reject** controls; Reject requires a typed reason.
  2. **Request Detail** — a single request's full state plus its **audit timeline** rendered from
     `GET /approvals/:rid/events` (`requested → approved/rejected/expired → executed/failed`),
     with actor and any decision reason / execution result / error.
  3. **Policy management (human-only)** — list policy rules, **add** a rule for an action type with
     `requireApproval` and an optional **spend threshold** (`maxAutoAmount`), and **delete** a rule.
  4. **Live updates** — the queue refreshes when an `approval` notification arrives over the #5 `/ws`
     gateway (the #8 `NotificationEvent` with `type:"approval"`), with no manual refresh.
- **Out of scope (deferred):**
  - Any **non-additive** server change. We consume the #13 REST + #5/#8 WS contract as it exists.
    The only client-side addition is mirroring the **already-emitted** `notification` server event
    into the web `ServerEvent` union (the server sends it today; the web types simply did not list it).
  - **Submitting** gated actions from the UI (an action-composer) — agents/CLI submit; this panel
    reviews. A tiny optional dev affordance may exist behind the demo only, not in the product UI.
  - Per-request real-time patching of a single row's status from a granular event (we re-fetch the
    affected status bucket on an `approval` notification — see *Known constraints* #2).

**Success looks like:** a human opens **Approvals**, sees a pending gated action an agent just
submitted (it appeared live), reads its summary + TTL, clicks **Reject** and types a reason (or
**Approve**), watches it leave the pending list and land under rejected/executed, opens it to read
the audit timeline, then opens **Policies** and adds a rule so `external.send` over $100 pauses —
all against the unmodified #13 backend.

### Acceptance criteria (testable)

1. **Queue render:** the panel lists requests for the workspace; status tabs
   (`pending/executed/rejected/expired`) filter via `GET /workspaces/:wid/approvals?status=`; each
   pending row shows summary, requester (resolved name), action type, amount, and a TTL countdown.
2. **Approve (human):** a human clicking **Approve** on a pending row calls
   `POST /approvals/:rid/approve`; on success the row leaves pending and the executed/decision state
   is reflected; an executor failure surfaces the `failed` error without crashing the panel.
3. **Reject (human, reason required):** **Reject** opens a reason input; submitting an empty reason
   is blocked client-side; a non-empty reason calls `POST /approvals/:rid/reject` and the row leaves
   pending.
4. **RBAC — humans only:** when `identity.kind === "agent"`, Approve/Reject controls and the entire
   Policies editor are **not rendered** (mirrors the server `requireHuman` 403). Agents still see the
   queue and audit timelines (read-only).
5. **Self-approval guard:** the requester does not see Approve on **their own** request (mirrors the
   server `cannot approve your own request` 403); if attempted, the 403 is surfaced, not swallowed.
6. **Audit timeline:** opening a request renders its events from `GET /approvals/:rid/events` in
   order with event type, actor (resolved name or "system"), and detail (reason / result / error).
7. **Policies (human):** the Policies view lists rules from `GET /workspaces/:wid/approval-policies`;
   adding a rule (`POST`) appears in the list; deleting (`DELETE …/:ruleId`) removes it; the spend
   threshold (`maxAutoAmount`) is editable and shown.
8. **Live update:** an `approval` notification delivered over `/ws` triggers a refresh of the pending
   queue so a newly gated action appears without a manual refresh.
9. **Conflict handling:** approving/rejecting an already-decided or expired request (409) shows a
   non-fatal "already decided / expired" message and reconciles the row.

## API contract (consumed as-is from #13)

All same-origin; the httpOnly `rid` cookie rides along (`credentials:"include"`), per ADR-0018.

| Purpose | Method & path | Notes |
|---|---|---|
| Submit/queue an action | `POST /workspaces/:wid/actions` | returns `SubmitActionResponse` (`pending`\|`executed`). Used by the **demo** to create gated actions; not the product UI. |
| List queue | `GET /workspaces/:wid/approvals?status=` | `status ∈ pending\|approved\|executed\|failed\|rejected\|expired`; omit for all. Returns `ApprovalRequestDto[]`. |
| Request detail | `GET /approvals/:rid` | `ApprovalRequestDto`; cross-workspace ⇒ 404. |
| Audit events | `GET /approvals/:rid/events` | `ApprovalEventDto[]`, append-only, chronological. |
| Approve | `POST /approvals/:rid/approve` | body `{ reason? }`; human-only (403), self-approve ⇒ 403, already-decided ⇒ 409, expired ⇒ 409. Executes ⇒ `executed`\|`failed`. |
| Reject | `POST /approvals/:rid/reject` | body `{ reason? }`; human-only; conflict ⇒ 409. |
| List policies | `GET /workspaces/:wid/approval-policies` | `ApprovalPolicyDto[]`. |
| Upsert policy | `POST /workspaces/:wid/approval-policies` | body `{ actionType, requireApproval?, maxAutoAmount? }`; human-only; ⇒ 201. |
| Delete policy | `DELETE /workspaces/:wid/approval-policies/:ruleId` | human-only; missing ⇒ 404. |

**Shared DTOs (reused, not redefined):** `ApprovalRequestDto`, `ApprovalEventDto`, `ApprovalPolicyDto`,
`SubmitActionResponse`, `ApprovalStatus`, `ApprovalActionType` from `@reload/shared`
(`packages/shared/src/index.ts`). This is exactly ADR-0018 decision #6 ("where `@reload/shared` has
a type, it is reused") — #13 added these, so the client imports them instead of hand-mirroring.

## Known constraints (consumed as-is — drove these decisions)

1. **`notification` event not yet in the web `ServerEvent` union.** The server **already emits**
   `{ type:"notification", notification: NotificationEvent }` and the gateway delivers it to the
   recipient's sockets regardless of channel subscription (`realtime/gateway.ts`). The web
   `api/types.ts` simply never listed it. We **additively** add `NotificationEvent` + the
   `notification` variant to the web union and handle `type:"approval"`. **No server change.**
2. **No per-request realtime patch.** The `approval` notification signals "a decision is needed" but
   carries no request id we can map to a row. So a live `approval` event triggers a **re-fetch of the
   pending bucket** (cheap, workspace-scoped) rather than patching one row. Decisions made *in this
   client* update state from the decision response directly.
3. **No "member by id" endpoint.** Requester/actor names resolve via the existing #18 **directory**
   (member search); unknown ids fall back to a short member-id badge (same pattern as messaging).
4. **`approved` is transient.** The backend moves `pending → approved → executed/failed` within one
   request; the UI treats `approved` as an in-flight state and primarily surfaces the terminal
   `executed`/`failed`.

## Architecture

Extends the existing **single-store / no-router** web app (ADR-0018). The store gains an **approvals
slice**; new components render inside the shell as a switchable **Approvals** view (state, not route).

```
apps/web/src/
  api/
    types.ts        # + NotificationEvent + { type:"notification" } ServerEvent variant (additive)
    client.ts       # + approvals.* methods (queue, detail, events, approve, reject, policies, submit)
  store/
    store.ts        # + approvals slice: queue-by-status, activeRequest, events, policies;
                    #   loadApprovals/approve/reject/loadPolicies/addPolicy/deletePolicy;
                    #   onEvent: notification(approval) ⇒ refresh pending
  components/
    approvals/
      ApprovalsPanel.tsx   # tabbed shell: Queue | Policies; opens RequestDetail
      ReviewQueue.tsx      # status tabs + rows; Approve/Reject (human-only) ; TTL countdown
      ReviewRow.tsx        # one request row + inline reject-reason form
      RequestDetail.tsx    # request header + audit timeline from /events
      AuditTimeline.tsx    # ordered ApprovalEventDto[] render
      PolicyManager.tsx    # human-only: list + add + delete rules, spend threshold
      ttl.ts               # pure: format age / time-to-expiry from ISO timestamps
    Workspace.tsx          # + nav affordance to open the Approvals view
```

**RBAC discipline (mirrors server `requireHuman`):** decision controls and the Policies editor are
gated on `identity.kind === "human"`. This is defense-in-depth UX, **not** the security boundary —
the server still enforces 403; the client also surfaces any 403/409 rather than hiding failures.

**Realtime discipline:** the store already `realtime.connect()`s and registers `onEvent`. We add a
`notification` case: when `notification.type === "approval"`, refresh the pending bucket. No new
subscription is needed (notifications are delivered per-recipient, not per-channel).

## PLAN — atomic tasks (each independently buildable & testable, TDD)

1. **Types (additive):** add `NotificationEvent` + `{type:"notification"}` to `api/types.ts`; import
   approval DTOs from `@reload/shared`. Unit: parse/typecheck.
2. **API client:** `api.approvals.*` (list, get, events, approve, reject, listPolicies, addPolicy,
   deletePolicy, submitAction). Unit tests with mocked `fetch` (paths, bodies, error mapping).
3. **TTL helper:** `ttl.ts` pure formatters (age, time-to-expiry, expired). Unit tests.
4. **Store slice:** approvals state + actions + the `notification(approval)` live-refresh. Unit tests
   with a fake api + fake realtime (queue load, approve removes from pending, reject requires reason
   path, policy add/delete, live refresh on event, 409 reconciliation).
5. **ReviewQueue + ReviewRow:** status tabs, rows, human-only Approve/Reject, reason form, TTL.
   Component tests (human vs agent visibility, self-approve hidden, reject-empty blocked).
6. **RequestDetail + AuditTimeline:** open a row, render events in order. Component tests.
7. **PolicyManager:** list/add/delete, threshold, human-only. Component tests.
8. **ApprovalsPanel + Workspace wiring:** tabbed shell, open/close detail, nav entry. Component test.

## VERIFY

- **Gates (from `platform/`):** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green.
- **Demo:** `scripts/demos/18-approvals-panel.sh` — boots Postgres+Redis+server, signs in two members
  (a requester agent/human + a human reviewer), submits a gated `external.send` over threshold via
  `POST …/actions`, shows it arrive live in the reviewer's queue, approves/rejects, and prints the
  audit chain. Mirrors the #18 demo style.
- **Browser (optional, `browser-testing-with-devtools`):** drive queue → reject-with-reason → detail
  timeline → add policy; screenshots as evidence.

## Definition of Done

- This spec + **ADR-0026** committed before code.
- Tests written first (red → green), incrementally; component + store/integration coverage.
- All four gates green from `platform/`.
- Reviewed per `code-review-and-quality` + `security-and-hardening` (RBAC surfaced, failures not
  swallowed, no server security weakened).
- Shipped as **one PR** linking #18/#13 with the demo; **reviewed by @gagan114662 — not merged here.**
