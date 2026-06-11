# Spec 148 — Reliability surface (incident.io-class)

- **Issue:** [#148](https://github.com/gagan114662/agent-skills/issues/148)
- **ADR:** [docs/adrs/0148-reliability-surface.md](../adrs/0148-reliability-surface.md)
- **Builds on:** #112 SRE Loop (`sre_incidents`, the `SreNotifier` seam), #108/#139 uptime monitor,
  #117 failure fingerprints, #113 saturation, #73 deployments, #104 Founder Console, the #8/#123
  channel + message infra, #58 layered config, #99 maintenance/DR runbook.

## Problem

The SRE Loop (#112) and the uptime monitor (#108) detect outages, but nobody is **paged**: the uptime
check opens a GitHub issue, and an SRE incident posts one chat line into whatever ops channel happens
to be live. There is no public status page, no dedicated incident war-room, no AI investigation note
on open, and no MTTR/frequency view. incident.io's whole pitch — on-call + response + AI SRE + status
pages — is the operating layer ipop is missing. This slice closes that gap **on top of the existing
incident** (#112's `sre_incidents`), adding no new detection authority.

## Goals (acceptance criteria)

1. **Owner paging / on-call.** A notification seam (email first; pluggable push/SMS later) that pages
   the **workspace owner's verified contact** when an incident opens, re-pages on a sustained
   **unacked** breach (escalation policy), respects **quiet hours**, and is **rate-limited**. Wired to
   both the SRE loop (#112) incidents and the uptime monitor (#108) alerts. Inbound owner pages are not
   external marketing sends, but are still **config-gated and default-OFF**.
2. **Public status page.** A **no-auth** route showing component health (API, DB, Redis / "agents")
   derived from `/readyz`, plus a redacted incident history from the SRE loop, auto-updating. Opt-in
   per workspace (keyed on the workspace slug); default-OFF ⇒ 404, so nothing is exposed until the
   owner turns it on. Per-venture status pages are deferred.
3. **Chat-native incidents.** When the SRE loop opens an incident, spin up a dedicated
   **`#incident-NNN`** channel in the workspace, post the timeline as it unfolds (detected → decided →
   triage launched → resolved), and close it with the postmortem summary — reusing the existing
   channel/message infra (no Slack dependency).
4. **AI investigation note.** On incident open, an investigation pass **correlates** recent deploys
   (#73), failure fingerprints (#117), and saturation (#113) into a structured *likely-cause +
   suggested-next-steps* note, posted to the incident channel and attached to the incident row.
   **Suggestions only** — every fix still flows through the flywheel → issue → agent path with #13
   gates intact.
5. **Insights pane.** MTTR, incident frequency, and noisiest components in the Founder Console (#104),
   fed by the existing `sre_incidents` rows.

## Non-goals

- No new outage **detection** — the SRE loop + uptime monitor stay the only sources.
- No auto-remediation — investigation is advisory; remediation rides the existing #13 / flywheel path.
- No external paging vendor (PagerDuty/Twilio) in this slice — the `PagerTransport` seam is the plug;
  email-first, default a structured-log transport that sends nowhere until SMTP is configured.
- No per-venture status pages yet (the slug-keyed route is the seam for them).

## Design

### Decision is pure; effects are seams (the #112 pattern)

| Pure module | Responsibility |
|---|---|
| `reliability/paging/decide.ts` `decidePage` | enabled → rate-limit → quiet-hours (critical breaks through) → ack/escalation/cooldown → deliver/suppress, with a `reason` |
| `reliability/investigation/correlate.ts` `correlateIncident` | rank likely causes from deploys/fingerprints/saturation; build suggested next steps (advisory) |
| `reliability/investigation/render.ts` `renderInvestigationNote` | the markdown posted to the incident channel + stored on the row |
| `reliability/status/compose.ts` `composeStatusPage` | component health + redacted incidents → `operational | degraded | major_outage` |
| `reliability/insights/aggregate.ts` `computeReliabilityInsights` | MTTR, frequency (7d/30d), open count, noisiest components |
| `reliability/timeline.ts` | the `#incident-NNN` channel name + timeline message bodies |
| `reliability/caps.ts` `resolveReliabilityCaps` | resolve the layered config; **default OFF** |

### IO seams (wired in `reliability/default.ts`)

- **`IncidentCoordinator` implements the existing `SreNotifier` seam.** No `engine.ts` change. The
  engine already calls `notifier.notify({ kind: "opened" | "repaged" | "resolved" })` on open, re-page,
  and resolve. The coordinator:
  - **opened** → ensure the `#incident-NNN` channel, post "detected", run the investigation pass
    (gather deploys/fingerprints/saturation → `correlateIncident` → `renderInvestigationNote` → post +
    persist on the overlay row), then **page the owner** through the pager.
  - **repaged** → post a "still firing" line + page (suppressed if the incident is acked / inside quiet
    hours / rate-limited — the pure `decidePage` decides).
  - **resolved** → post the postmortem summary + page "resolved".
  - **When `reliability.enabled` is false for the workspace, the coordinator delegates to today's
    plain ops-channel post** — byte-for-byte the #112 behavior, so wiring it changes nothing until the
    owner opts in.
- **`PagerService`** resolves the owner's verified email (a new `members → users` join), calls
  `decidePage` (reading the recent page log for the rate-limit window + the overlay's ack state), and
  delivers via a **`PagerTransport`** (default `LogPagerTransport`; `EmailPagerTransport` when SMTP is
  configured). Egress-gated by #58 data-privacy mode. Used by **both** the coordinator and the uptime
  CLI.
- **`StatusPageService`** resolves a workspace by slug, gates on `reliability.statusPage.enabled`, reads
  `/readyz` component pings + `listIncidents`, and runs `composeStatusPage`.

### Persistence (migration `0148_reliability_surface`)

Two new workspace-scoped tables; **`sre_incidents` is untouched** (the overlay keeps the reliability
surface isolated and additive):

- **`reliability_incidents`** — the overlay, one row per SRE incident: `incident_id` (soft ref, UNIQUE),
  `seq` (the per-workspace `NNN`), `channel_id` (the war-room), `investigation_note`, and the paging
  state (`last_paged_at`, `acked_at`, `page_count`).
- **`reliability_pages`** — the page audit + rate-limit window source: `source` (`sre | uptime`),
  `incident_id` (nullable — uptime has none), `kind`, `recipient`, `delivered`, `suppressed_reason`.

### Surfaces

- **Public:** `GET /status/:slug` — unauthenticated, 404 unless that workspace opted in. Web renders a
  standalone `StatusPage` **before** the `AuthGate` (path-based, no router dependency).
- **Authenticated:** `POST /workspaces/:wid/reliability/incidents/:incidentId/ack` sets `acked_at`
  (stops the escalation re-page). The Founder Console gains a read-only **reliability insights** pane.

### Config (`reliability`, default-OFF, #58 layered)

```
reliability:
  enabled: false              # paging + chat-native incidents + investigation (master switch)
  pager:
    quietHoursStartHourUtc?   # inclusive; pages within the window are held unless critical
    quietHoursEndHourUtc?
    maxPagesPerHour?          # rate limit (default 6)
    escalateAfterMs?          # re-page an unacked incident only past this (default 15m)
    pageOnResolve?            # send the "resolved" page (default true)
    emailFrom? / smtpUrlVar?  # secret-var NAME only, never a value
  statusPage:
    enabled: false            # the public /status/:slug surface
```

## Testing

- **Unit (pure):** `decidePage` (every branch: disabled, rate-limited, quiet-hours hold + critical
  break-through, acked suppression, escalation cooldown, deliver), `correlateIncident` (deploy-window
  cause, saturation-critical cause, fingerprint recurrence, ranking, advisory next-steps),
  `composeStatusPage` (overall status derivation + redaction), `computeReliabilityInsights` (MTTR,
  7d/30d frequency, noisiest), `resolveReliabilityCaps` (defaults OFF), `timeline` names/bodies.
- **Coordinator unit:** opened path creates a channel, posts a note, pages; **OFF delegates** to the
  plain post and never pages; repaged is suppressed when acked; resolved posts the summary.
- **Integration (real PG):** the overlay + pages repos + owner-contact join; the coordinator end-to-end
  against the DB; the public status route (opted-in 200, default-OFF 404); the ack route; the console
  insights pane.

## Rollout

Default-OFF at every gate (`reliability.enabled` + `statusPage.enabled`, both false; the pager
transport is a no-op log until SMTP is set). Wiring the coordinator as the SRE notifier is behavior-
preserving for un-opted-in workspaces. No change to existing schemas or tests.
