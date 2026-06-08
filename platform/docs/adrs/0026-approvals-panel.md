# ADR-0026: Web Approvals Panel — the governance UI for #13

- **Status:** Accepted (Gagan pre-approved end-to-end execution — issue #18 approval-queue slice)
- **Date:** 2026-06-08
- **Context issues:** [#18](https://github.com/gagan114662/agent-skills/issues/18) (web client),
  [#13](https://github.com/gagan114662/agent-skills/issues/13) (approval gates backend)
- **Builds on:** [ADR-0013](0013-approval-gates.md) (approval gates), [ADR-0018](0018-web-client.md)
  (web shell: store, realtime, auth), [ADR-0005](0005-realtime-messaging.md) (`/ws` gateway),
  [ADR-0008](0008-notifications.md) (`approval` notification), [ADR-0009](0009-registry-rbac.md) (humans decide)

## Context

#13 shipped the human approval gates backend: a pure policy engine, a gated-action submission seam
(`POST /workspaces/:wid/actions`), human-only decisions (`approve`/`reject`), an append-only audit
chain, and TTL expiry — exposed only over REST/CLI. #18 shipped the web shell (single in-memory
store, `/ws` realtime client, auth) and **explicitly deferred** the approval queue to a later
sub-PR. This ADR covers that sub-PR: the **Approvals Panel** — review queue, request detail with
audit timeline, and policy management — rendered inside the #18 shell against the unmodified #13 API.

## Decisions

1. **Reuse the `@reload/shared` approval DTOs instead of hand-mirroring.** ADR-0018 §6 set the rule:
   the web app hand-mirrors wire types only because the server doesn't export them; **where
   `@reload/shared` has a type, the client reuses it.** #13 added `ApprovalRequestDto`,
   `ApprovalEventDto`, `ApprovalPolicyDto`, and `SubmitActionResponse` to the shared package, so the
   panel imports them directly. This guarantees the UI and server can never drift on the approval
   contract — the single highest-risk surface here (decisions are irreversible side effects).

2. **Live updates reuse #5/#8 — and require only an *additive, client-side* type fix, no server
   change.** The server **already emits** `{ type:"notification", notification: NotificationEvent }`
   and the gateway delivers it to a recipient's sockets regardless of channel subscription
   (`realtime/gateway.ts`); #13 sends an `approval`-typed notification to every other human reviewer
   when an action is gated. The web `api/types.ts` simply never listed the `notification` variant. We
   add `NotificationEvent` + the `notification` case to the web `ServerEvent` union and handle
   `type:"approval"`. The server is untouched (the spec's "additive if strictly needed" bar is met by
   a *web-only* type addition that describes an event the server was already sending).

3. **An `approval` notification triggers a pending-bucket re-fetch, not a per-row patch.** The #8
   notification announces "a decision is needed" but carries no approval-request id we can map to a
   row (its `taskId`/`messageId`/`channelId` references don't include the request). Rather than
   weaken the trust boundary by guessing, the store re-fetches `GET …/approvals?status=pending` on an
   `approval` event — a cheap, workspace-scoped read. Decisions made *in this client* update state
   from the authoritative decision response, so the common path needs no round-trip. (A future #13
   server PR could add the request id to the notification, or push a granular approval event; until
   then re-fetch is correct and simple.)

4. **Human-only controls are defense-in-depth UX, not the security boundary.** The server enforces
   `requireHuman` (403) on every decision and policy write, plus a self-approval guard and
   already-decided/expired 409s. The client mirrors this by **not rendering** Approve/Reject or the
   Policies editor when `identity.kind === "agent"`, and by hiding Approve on the caller's own
   request. But it never *relies* on hiding: every 403/409 from the server is **surfaced**, not
   swallowed, so a stale UI (e.g. two reviewers racing) reconciles visibly instead of lying. Security
   stays server-side (ADR-0009/0013); the UI just avoids dangling buttons.

5. **The panel is a view, not a route — consistent with the no-router store (ADR-0018).** Approvals
   is an `activeView` state switch in the single store, with an `activeRequestId` for the detail
   pane. The store gains one **approvals slice** (queue-by-status, active request + its events,
   policies) and the actions to drive it; components stay presentational and read via
   `useSyncExternalStore`. No new state library, no router — the same shape the shell already uses.

6. **The panel reviews; it does not submit.** Gated actions are produced by agents/CLI via
   `POST /workspaces/:wid/actions`. The product UI deliberately has **no action-composer** — mixing
   "ask to do a sensitive thing" into the reviewer surface invites accidental self-gating and clutters
   the governance view. The demo script uses the actions endpoint to *manufacture* a gated request so
   the live-queue and decision flow are provable end-to-end; that affordance stays in the demo, not
   the product.

## Consequences

- The platform gains the human governance surface #13 was built for, **purely additively** on the
  server (zero API changes; one web-only type addition describing an already-emitted event).
- TTL is rendered from `expiresAt`; the countdown is presentation-only — expiry is still enforced
  server-side (sweep + decision-time check), so a client clock skew can never approve an expired
  request (the server returns 409 and the row reconciles).
- Coverage: store-slice unit tests (queue load, approve removes-from-pending, reject reason-required,
  policy add/delete, live refresh on `approval` event, 409 reconciliation) + component tests
  (human-vs-agent control visibility, self-approve hidden, audit timeline order, policy editor),
  on top of the #18 suite. Verified via `scripts/demos/18-approvals-panel.sh`.
- Follow-ups recorded for a later #13 server PR (not done here): include the approval-request id in
  the `approval` notification (or push a granular approval event) so the client can patch a single
  row instead of re-fetching the pending bucket.
