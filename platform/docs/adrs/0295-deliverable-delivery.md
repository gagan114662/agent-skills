# ADR-0295: Approve→publish — ship an approved deliverable through a real channel adapter

- **Status:** Accepted (shipped in PR for #295)
- **Date:** 2026-06-16
- **Context issue:** [#295](https://github.com/gagan114662/agent-skills/issues/295) — the v5 console
  departments (Scout/SEO, Echo/social, Quill/content, Postmark/email, Bid/ads) draft work and STOP: a
  completed session surfaces a "Deliverable ready for review" card that piles up in **Approval needed** and
  never actually ships. Wire approve→publish so the owner's approval makes the draft go live (post/publish/
  send) through a real channel, and record a production-grounded receipt (URL / post id / message id /
  timestamp) proving it shipped. Owner-gated, **default OFF**, owner-workspace-first.
- **Builds on:** [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md) (the #13
  approval queue + the money-only gate — the executor registry this extends), ADR-0248 (the
  `agent.deliverable` review card a completed session surfaces, previously a pure acknowledgement),
  [ADR-0189](0189-acquisition-execution.md) (the `external.send` → `AcquisitionDispatcher` pattern this
  mirrors, and its dry-run channel providers this reuses), [ADR-0231](0231-real-world-tool-surface.md) (the
  `PublishProvider` "HTML → live reachable URL" capability + its health-check verification),
  [ADR-0123](0123-marketing-department-fleet.md) (the marketing blueprint — the structural department↔channel
  map), [ADR-0223](0223-decision-maker-resolver.md) (structural-not-instructions injection defense),
  [ADR-0035](0035-config-layering.md) (the layered feature-flag config), [ADR-0200](0200-premortem-panel.md)
  (the standing premortem this answers to).

## Context

Issue #248 made a completed agent session SURFACE its draft as an `agent.deliverable` review card in the
#13 APPROVAL NEEDED queue so a briefed task never "vanishes". But the executor for that action was a pure
**acknowledgement** — approving recorded that the owner saw the draft and did nothing else, because under
the money-only policy (#243) publishing/sending was nominally "autonomous". In practice the autonomous send
path is not wired for the department deliverables, so the fleet **drafts and stops**: cards accumulate in
"Approval needed (6 waiting on you)" and ipop does no real marketing. This is the gap between "clean in
Conductor" and a working live product.

The standing premortem (#200) sets the rails: an "it shipped" claim must rest on an **external receipt**
(§2), verification must be **production-grounded** (§3), **irreversible/public** actions must be
**pre-committed and human-gated** (§4), and a poisoned web read must never steer an autonomous write (§6).

## Decision

Make the **owner's approval of an `agent.deliverable` the ship trigger**, behind a default-OFF flag, by
giving the existing executor an optional **delivery dispatcher** — the exact shape ADR-0189 used to turn the
recorded-only `external.send` executor into a real campaign sender.

1. **Pure routing brain** (`delivery/decide.ts`). `decideDelivery({ department, flags, draft })` decides
   WHETHER and through WHICH channel a deliverable ships. Routing is a pure function of the **structural
   department** (Scout/SEO + Quill/content → `publish`; Echo → `social`; Postmark → `email`) and the
   workspace flags — it **never inspects the draft text** (injection defense, #200 §6). The draft's only
   role is `nonEmpty`. `resolveDeliveryFlags` is DEFAULT-OFF and owner-workspace-first: the master flag must
   be on AND the workspace in scope (`ownerWorkspaceOnly` defaults true ⇒ only the named owner workspace
   ships; turning the flag on without naming it ships to nobody). Ads is deliberately **not** shippable here
   — an ads deliverable is a SPEND PLAN, and real ad spend stays money-gated (#189/#187).

2. **Dispatcher** (`delivery/dispatcher.ts`). After approval, `ship(payload, ctx)` resolves the structural
   department, asks `decideDelivery`, routes to the channel adapter, and records a durable receipt. It is
   **fail-closed**: `ship` returns `null` — falling back to the pure acknowledgement (today's behavior) —
   when the approval id is empty, delivery is off, the department is not shippable, or the draft is empty.
   A real ship that FAILS records a `failed` receipt and throws `ActionExecutionError`, so the #13 request
   is marked `failed` — never a silent success.

3. **Channel adapters** (`delivery/adapters.ts`) reuse EXISTING providers — no new actuator is invented:
   - `publish` reuses the #231 `PublishProvider`: wraps the (HTML-escaped) draft into a standalone page,
     publishes it to a live URL, then **HEAD-checks the URL to prove it is live** (#200 §3). `live:true`
     only when the URL actually answers; the dry-run provider yields `live:false`.
   - `social`/`email` reuse the #189 dry-run providers. No customer credentials/Stripe (a #295 hard
     constraint) ⇒ these stay `live:false`; a real X/LinkedIn or ESP adapter behind connected credentials
     is a deliberate future ADR. Email ships with **NO recipients** (a content draft carries none), so it
     can never reach a real inbox here.

4. **Production-grounded receipt** (`delivery_receipts`, migration 0295). Every ship (or failure) writes a
   row carrying the **`approval_request_id`** (the #13 approval that authorized it — the structural proof
   nothing ships without an approval), the `channel`/`reversibility`, the `provider`, a `live` boolean
   (true only for a real external surface — the console never overclaims a dry-run as live), the
   `external_ref` (the live URL / post id / message id), and `shipped_at`. Workspace-scoped (#3);
   `approval_request_id`/`session_id` are soft refs so the receipt outlives a pruned approval/session.

5. **Wiring.** `buildDefaultRegistry` takes an optional 4th `DeliveryDispatcher`; `agent.deliverable`
   becomes a factory `makeAgentDeliverable(delivery?)`. `executeApprovedRequest` threads the approval
   `request.id` into the executor context. `buildAcquisitionRegistry` (the registry the app wires into the
   approval routes) now also builds the delivery dispatcher. All of it is default-OFF: with no dispatcher,
   or the flag off, the executor is **byte-for-byte** the old acknowledgement.

## Consequences

- **The core gap closes**: an approved department deliverable actually ships and leaves a receipt the
  console can read (`listDeliveryReceipts` / `countLiveDeliveries`) — honest "what shipped" evidence (#200
  §2), not a self-reported claim.
- **Nothing ships without an explicit owner approval.** The executor only runs post-approval; the
  dispatcher additionally refuses to ship without a non-empty approval id; the deliverable card is created
  `pending` and only a human can approve it (#13). A unit test (`delivery-dispatcher.test.ts`) and an
  integration test assert this directly.
- **Irreversible/public actions are human-gated and pre-committed** (#200 §4): the owner reviews the exact
  draft on the card before approving; `social`/`email` carry the `irreversible` reversibility class.
- **Injection-safe** (#200 §6): the channel/target is structural (from the department), never parsed from
  the draft; the publish adapter HTML-escapes the draft so injected markup renders as inert text.
- **Default-OFF, reversible blast radius**: the only genuinely-live channel without customer credentials is
  `publish` (a page that can be taken down); `social`/`email` are dry-run until a credentialed adapter is a
  future ADR. The owner turns delivery on for their own workspace first.

## Alternatives considered

- **A new `deliverable.ship` action type.** Rejected — it would double the queue surface and duplicate the
  #248 card. Extending the existing `agent.deliverable` executor (the ADR-0189 pattern) reuses the card,
  the gate, and the audit trail.
- **Reuse `realworld_artifacts` for receipts.** Rejected — its `status` enum (`published`/`blocked`/…) has
  no honest slot for a dry-run send, so reusing it would force `social`/`email` to be recorded as
  `published`, overclaiming a live send (against #200 §2). A dedicated table with an explicit `live` boolean
  models the truth.
- **Ship autonomously (no gate) under #243's money-only policy.** Rejected for public/irreversible sends:
  the premortem (#200 §4) requires them human-gated. The owner's approval IS the gate, which is also what
  #295 asks for ("keep the live send owner-gated").
