# ADR-1456: CMO summary strip — every top-line metric carries honest provenance, never a fake number

- **Status:** Accepted (revenue / P0 — #1456)
- **Date:** 2026-07-02
- **Context task:** GitHub issue #1456 — "P0: Dashboard needs CMO-grade business metrics, not agent
  theater." The signed-in dashboard shows activity but does not make the owner instantly understand
  whether the agent team is creating business value. A CMO opening ipop wants the six answers in <10s:
  what shipped, what pipeline/revenue moved, which channels are live vs blocked, which agents create
  usable assets, what needs approval now, and what to upgrade because a real limit was hit.
- **Builds on:** ADR-0200 (premortem rails — §2 self-reported metrics are fiction, only external
  receipts; §4 irreversible/money stays human-gated; §6 external/connector content is untrusted DATA),
  the everyday-shell surface (#784), the since-last-check-in slice (#1465), and the ranked-agent-work
  slice (#1487). Reuses the existing seams: the store approval queue, `api.getConnections()`
  (`ConnectionView.connected/status`), and the transparency receipt log (`ExternalAction.href`).

## Context

Prior #1456 slices shipped the CMO-brief *surface* (executive summary, since-last-check-in, ranked
work, funnel, channels, blockers, readiness). But the top-line business numbers were still **hardcoded
zeros and authored copy**: pipeline created/touched, qualified leads / conversations / booked meetings,
shipped-assets-by-channel, and spend/revenue movement all rendered a literal `0` with a proof string
that *implied* it had been measured. That is precisely the failure the premortem forbids (#200 §2): a
"0 qualified leads" with no connected source reads to a CMO as "the agents did nothing," when the truth
is "nothing is connected to even measure it." Self-reported/implied numbers are fiction.

The task's hard boundaries also forbid connecting real customer/revenue sources here: no credentials, no
external sends, no money movement. So the honest move is not to *fake* the numbers and not to try to
*unblock* them — it is to make the **provenance of every metric explicit**, and render an unconnected
metric as "not connected yet" or an owner-gated one as "blocked — needs owner."

## Decision

Add a **CMO summary strip** at the very top of the dashboard: six tiles, one per CMO question, each
wearing an honest provenance badge. Drive it from a **pure, deterministic resolver** that reads only the
real seams the dashboard already gathers — it pulls no new data, holds no credentials, and sends nothing.

- **Pure module** (`components/everyday/cmo-summary.ts`, fully unit-tested). `resolveCmoSummary({ live,
  connectors, approvals, receipts })` returns exactly six `CmoSummaryMetric`s (`pipeline`, `leads`,
  `shipped`, `revenue`, `approvals`, `channels`), each with a `provenance`:
  - `"receipt"` — backed by a real, internally- or externally-verifiable receipt (the approval queue,
    the connector catalog, or a shipped-artifact receipt link). **Real numbers only.** A measured zero
    (e.g. approvals = 0, or a live publishing channel with nothing shipped yet) is honest here.
  - `"not_connected"` — no source is wired. Renders "connect X to track", **never a fabricated `0`**.
  - `"blocked"` — a source connector is blocked, **or** the metric lives behind an owner-gated
    capability (money). Renders "blocked — needs owner". `spend / revenue` is *always* blocked: money
    movement is never automated (#200 §4 + the task boundary "render it as blocked — needs owner rather
    than faking it").
  Provenance keys **only off structural enums** (connector `group`/`status`), never off connector
  free-text, so a poisoned connector name cannot change the logic (#200 §6). All displayed text is run
  through a control-char-stripping, length-capped `sanitizeText`.
- **Upgrade/limit moment tied to real value.** The resolver returns an `upgradeMoment` **only** when
  receipt-backed value (a shipped receipt or a pending approval) sits behind a genuinely blocked
  channel — so the connect/upgrade prompt is always attached to proven value, never arbitrary pricing
  copy (#200 §5 / the issue's "clear upgrade/limit moments tied to real value").
- **Presentation** (`EverydayShell.tsx` `CmoSummaryStrip`): renders the six tiles + the optional
  upgrade note, with the provenance badge, a real "see receipt" link when one exists, and a "needs you"
  marker on owner-gated tiles. Responsive grid (3-up desktop, 2-up mobile) with `overflow-wrap` so long
  states never overflow.
- **Default-OFF, owner-workspace-first flag** (`cmo-summary-flag.ts`, `VITE_CMO_SUMMARY_STRIP` +
  `VITE_CMO_SUMMARY_OWNER_WORKSPACE_ID`). The strip is read-only (no send/spend/irreversible action),
  but per the rollout rule any new surface ships fail-closed and proves out on the owner workspace
  first. `LiveEverydayShell` computes the gate from the current workspace; the public prerender and the
  sample paths follow the flag (production renders byte-for-byte unchanged until the owner flips it).

## Consequences

- **No fake numbers.** Every top-line metric now shows a real receipt-backed value or an explicit
  not-connected / blocked-needs-owner state — the issue's core acceptance and the #200 §2 rule.
- **Money and unconnected external sources stay honest and owner-gated.** Revenue/spend is always
  "blocked — needs owner"; pipeline/leads are "not connected yet" until the owner connects a source.
  Nothing here connects a source, sends, or moves money.
- **Regression-covered states.** Unit tests cover the resolver (empty / partially-connected /
  active-work / untrusted-connector-data) and component render tests cover the strip in all three
  required states plus the default-OFF hidden state.
- **Not a data feed.** This does not wire a CRM/analytics/billing connector — that remains a documented
  follow-up requiring owner-connected sources (and credentials), explicitly out of scope for #1456's
  boundaries. The strip is the honest frame that shows exactly what is and isn't connected.
