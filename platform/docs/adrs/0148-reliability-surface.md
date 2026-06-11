# ADR-0148: Reliability surface — owner paging, public status page, chat-native incidents, AI investigation

- **Status:** Accepted (shipped in PR for #148)
- **Date:** 2026-06-11
- **Context issue:** [#148](https://github.com/gagan114662/agent-skills/issues/148)
- **Spec:** [docs/specs/148-reliability-surface.md](../specs/148-reliability-surface.md)
- **Builds on:** [ADR-0112](0112-sre-loop.md) (the `sre_incidents` lifecycle + the `SreNotifier` seam
  this slice implements), [ADR-0108](0108-production-posture.md) (the uptime monitor it pages from),
  [ADR-0117](0117-self-healing-flywheel.md) (failure fingerprints the investigation correlates),
  #113 saturation, #73 deployments, [ADR-0050](0050-founder-console.md) (the insights pane host),
  the #8/#123 channel + message infra, [ADR-0035](0035-config-layering.md) (the layered config gate),
  and [ADR-0099](0099-disaster-recovery.md) (the maintenance pause + DR runbook the bundle links).

> **Numbering note.** Spec/migration/ADR all use the `0148` slot (the issue number), per the project's
> by-issue numbering convention (ADR-0099) — chosen to dodge sibling-workspace collisions in the shared
> migration sequence.

## Context

#112 made an SLO breach a *durable, triaged, documented* incident — but it stops at one chat line into
whatever ops channel is live, and #108's uptime monitor only opens a GitHub issue. Nobody is **paged**.
There is no public status page, no incident war-room, no AI investigation on open, and no MTTR view.
incident.io sells exactly this operating layer (on-call + response + AI SRE + status pages); it is the
half of "running a service" the autonomous fleet is missing. The hard constraints: page only the
**verified owner**, never weaken the #13 gates, and keep every new behavior **default-OFF** so an
un-opted-in deployment is byte-for-byte unchanged.

## Decisions

1. **Implement the existing `SreNotifier` seam — do not touch `engine.ts`.** The #112 engine already
   calls `notifier.notify({ kind: "opened" | "repaged" | "resolved" })` at exactly the three lifecycle
   moments this surface needs. The new `IncidentCoordinator` *is* that notifier. So the entire
   incident.io-class behavior (war-room channel, investigation note, owner page) attaches at a seam that
   already exists, with **zero change to the engine, the decision module, or any #112 test**. When
   `reliability.enabled` is false for a workspace the coordinator **delegates to the plain ops-channel
   post**, so the default path is the #112 path unchanged.

2. **Paging is pure decision + a transport seam.** `decidePage(input)` returns `{ deliver, reason }`
   with a deliberate order: disabled → rate-limited → quiet-hours (a `critical` page **breaks through**
   quiet hours, a warning is held) → acked-suppression / escalation-cooldown → deliver. No clock, no IO
   — every branch is a unit test. The `PagerService` resolves the **owner's verified email** (a new
   `members → users` join — there is no first-class owner column, so we take the workspace's human
   member), consults the page log for the rate-limit window + the overlay for ack state, and delivers
   through a `PagerTransport`. **Email-first**: the default is a structured-log transport (sends
   nowhere, so CI/tests need no SMTP); an `EmailPagerTransport` activates when an SMTP URL var is
   configured. Push/SMS are future transports behind the same seam. Egress obeys #58 data-privacy mode.

3. **Pages go ONLY to the verified owner, and are gated + rate-limited + quiet-housed.** An inbound
   page to the owner is not an external marketing send, but it is still `reliability.enabled`-gated
   (default OFF), capped at `maxPagesPerHour`, and suppressed during quiet hours (except `critical`).
   The owner stops the escalation by **acking** (`POST …/reliability/incidents/:id/ack`); an acked
   incident never re-pages.

4. **Wired to BOTH sources.** The SRE path pages through the coordinator (the notifier). The uptime
   monitor (#108) — a cross-process CLI — calls the **same** `PagerService` on its `open`/`recover`
   action, best-effort and config-gated, so a down apex domain pages the owner too. One pager, two
   callers, one pure `decidePage`.

5. **Chat-native incidents reuse the channel/message infra — no Slack.** On open the coordinator
   creates a `#incident-NNN` channel (`NNN` = a per-workspace sequence on the overlay), posts the
   timeline as it unfolds (detected → triage launched → resolved), and closes with the postmortem
   summary, via the existing `createChannel` + `channelPoster.post`. The war-room is durable chat the
   owner already reads.

6. **The AI investigation note is advisory, correlated from existing signals.** `correlateIncident`
   (pure) ranks likely causes: a deploy inside the pre-incident window (#73), a `critical` saturation
   sample (#113), and recurring failure fingerprints (#117) for the breached service — each with a
   confidence and a **suggested** next step. It **never acts**: remediation still flows through the
   flywheel → issue → agent path with #13 gates. The rendered note is posted to the incident channel
   and stored on the overlay row (`investigation_note`).

7. **The public status page is opt-in, slug-keyed, and redacted.** `GET /status/:slug` is
   unauthenticated; it resolves the workspace by its existing `slug`, **404s unless
   `reliability.statusPage.enabled`**, and returns component health (API/DB/Redis from the same
   `pingDb`/`pingRedis` `/readyz` uses) plus a **redacted** incident history (service, severity,
   status, timestamps — never observed/target internals). Default-OFF means nothing is exposed until
   the owner flips it. Per-venture pages are a later use of the same slug seam. The web renders a
   standalone `StatusPage` **before** the `AuthGate` (path-based; no router dependency added).

8. **Persistence is an additive overlay; `sre_incidents` is untouched.** `reliability_incidents`
   (one-per-incident overlay: channel id, seq, investigation note, paging state) and
   `reliability_pages` (the page audit + rate-limit window) are new workspace-scoped tables with
   `workspace_id` cascade and an `incident_id` **soft ref** (the overlay outlives pruned history).
   Keeping the SRE table unchanged means no ripple into #112's repo, types, or tests.

9. **Insights are pure, fed by `sre_incidents`.** `computeReliabilityInsights(incidents, now)` derives
   MTTR (mean resolve − open over resolved incidents), 7d/30d frequency, open count, and the noisiest
   components — surfaced as one **optional** Founder Console read seam (absent ⇒ a zeroed pane), like
   every other #104 pane.

## Consequences

- **Default-OFF, additive, no weakened tests.** `reliability.enabled` + `statusPage.enabled` both
  default false; the pager defaults to a no-op log; the coordinator delegates to the #112 post when off.
  Two new tables (`0148`), no change to existing schemas, and one optional console seam. Existing #112
  fakes and tests are untouched.
- **No new authority.** No new detection, no new launch path, no auto-remediation. Pages reach only the
  verified owner; remediation stays behind #13. The investigation only reads and suggests.
- **Bounded surface.** The whole feature attaches at one existing seam (`SreNotifier`), one existing
  cross-process caller (the uptime CLI), one public read route, one ack write, and one console pane.
- **Deferred (behind seams):** real SMTP/PagerDuty/Twilio transports (the `PagerTransport` plug),
  per-venture status pages (the slug seam), and routing triage into the war-room channel (today triage
  stays in the ops channel; the timeline is the human surface).
