# ADR-0173: Founder Briefings — the company reports to its owner (daily brief, weekly P&L, decision queue)

- **Status:** Accepted (shipped in PR for #173)
- **Date:** 2026-06-12
- **Context issue:** [#173](https://github.com/gagan114662/agent-skills/issues/173)
- **Spec:** [docs/specs/173-founder-briefings.md](../specs/173-founder-briefings.md)
- **Builds on:** [ADR-0050](0050-founder-console.md) (the read-only aggregate + IO-orchestrator +
  one-reader-seam-per-source pattern, tenant-scoped route), [ADR-0148](0148-reliability-surface.md)
  (owner delivery: the email-first `PagerTransport` seam + `getWorkspaceOwnerContact`),
  [ADR-0107](0107-portfolio-lifecycle.md) (per-venture P&L + kill/scale recommendations),
  [ADR-0114](0114-customer-voice-loop.md) (voice signals), [ADR-0115](0115-product-planning-loop.md)
  (next-week backlog), [ADR-0146](0146-constitution-enforcement.md) (constitution / pricing flags),
  [ADR-0172](0172-self-shipping-loop.md) (ships + guardrail escalations), [ADR-0013](0013-approval-gates.md)
  (the approval queue), [ADR-0099](0099-disaster-recovery.md) (maintenance Redis flag + by-issue numbering).

> **Numbering note.** Spec/migration/ADR all use the `0173` slot (the issue number), per the by-issue
> numbering convention (ADR-0099's note) — to dodge sibling-workspace collisions in the shared sequence.

## Context

The owner has stepped back from running every loop by hand, but the autonomy stack still requires them to
*pull* status: open the console, scan approvals, check spend, read the venture pipeline. Every number
exists; none of it is pushed. The directive: **the company reports UP** — the owner should never have to
poll to know what their company did. Three artifacts: a daily brief, a weekly founder report (P&L per
venture), and a single decision queue that never lets an owner-decision rot.

The hard parts are not the data (it all exists) but: (1) composing it **without acquiring any new
authority** over the business domain — a reporting layer must not be able to approve, kill, or price;
(2) **delivering** it without a hard dependency on Slack (#170, still in flight); (3) making "stale
decisions re-notify" work **without** a fragile per-decision notification-state machine.

## Decision

Add a **`founder-briefings/` reporting layer** that mirrors the #104 Founder Console wholesale — a pure
aggregate, an IO orchestrator with one injected reader seam per source, `default.ts` wiring over existing
repos, a thin tenant-scoped route — plus a #148-style email-first delivery seam, an opt-in scheduled
engine, and ONE tiny delivery-audit table. **Default-OFF.**

1. **Pure composition core.** `composeDailyBrief` / `composeWeeklyReport` / `composeDecisionQueue` are
   total functions over already-gathered structs with the clock passed in. The daily-brief renderer is
   **word-budgeted** — it emits highest-signal lines first and is proven `<= maxWords` (200) by a unit
   test on a maxed-out input. The decision queue is ordered **impact desc, then oldest-first**, so the
   route, the daily brief, and the weekly digest never disagree on priority.

2. **Read-only everywhere; the only write is the briefing's own audit.** Every reader seam is a query.
   The one persisted write is `founder_briefings` — the delivery audit + idempotency watermark, exactly
   as #148 `PagerService` always audits to `reliability_pages`. This is bookkeeping about *our own sends*,
   not authority over approvals/ventures/billing. Stated as a non-goal in the spec and enforced by the
   absence of any mutation reader/endpoint.

3. **Escalation by age, not by state machine.** `escalationLevel(age)` is a pure function of a decision's
   age against the caps thresholds. Because every daily brief re-surfaces the whole queue with each item's
   *current* level, a stale decision is automatically re-notified on a rising schedule — no per-item
   watermark, no notification cron, no drift. "Never silently rot" is a property of the daily cadence.

4. **Delivery is a seam; Slack rides the merged #170 authority.** `BriefingNotifier` delivers through the
   email-first #148 `PagerTransport` (log transport in CI/privacy mode) to the resolved owner, AND through
   an injected `SlackDeliverer`. #170 is now merged, so `default.ts` adapts the live `SlackEventService`
   (`slackBriefingDeliverer` → `sendOwnerDm` — the same owner-DM primitive the #170 digest uses); a
   workspace that hasn't connected Slack resolves `{ delivered:false, not_connected }`, and with no Slack
   service injected (CI/tests) the channel is the `NoopSlackDeliverer`. The seam means email never depends
   on Slack — Slack is an additional channel, not a prerequisite.

5. **Opt-in tick, default-OFF config.** The `FounderBriefingsEngine` mirrors the watchdog/SRE supervisor:
   maintenance-paused (#99) first, then iterate `listWorkspaceIds()`, compute daily (`YYYY-MM-DD`) +
   weekly (ISO `YYYY-Www`) period keys, and deliver — each call a no-op when already sent (the watermark)
   or when `briefings.enabled` is false. The timer is `BRIEFINGS_INTERVAL_MS` (default 0 = off); tests
   drive `tickWorkspace` deterministically.

## Consequences

- **Owner gets a push, not a pull.** A daily brief and weekly P&L arrive by email (and Slack when
  connected); the same views render in the Founder Console. Zero polling.
- **Honest P&L.** Per-venture economics come from the #107 portfolio review (`net = revenue − cost`);
  ventures without a review show "—" rather than a fabricated split, because billing revenue is
  workspace-level (no per-venture attribution exists — see ADR-0107).
- **No new blast radius.** The reporting layer cannot change anything; the worst failure is a missed or
  duplicate *send*, and the unique watermark prevents the duplicate. Disabling the config flag or the
  interval returns the deployment to byte-for-byte today's behavior.
- **One sibling-safe migration.** `0173` is numbered by issue; it adds one additive table and collides
  with no sibling branch.

## Alternatives considered

- **Extend the #104 console aggregate in place.** Rejected: the console is a single read endpoint; the
  briefings need *delivery* + a *scheduled tick* + a *word-budgeted render* the console doesn't. A sibling
  module keeps #104 a pure read and isolates the new send surface.
- **Per-decision notification-state table with a re-notify cron.** Rejected as over-built: age-derived
  escalation re-surfaced by the daily cadence achieves "never rot" with no extra state.
- **Couple delivery directly to the Slack client.** Rejected in favour of the `SlackDeliverer` seam: it
  let the layer be built and fully tested before #170 merged, and now that #170 is in main the seam adapts
  the live `SlackEventService` with a three-line `slackBriefingDeliverer` — email never depends on Slack.
