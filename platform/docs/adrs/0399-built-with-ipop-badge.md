# ADR-0399: "Built with ipop" tracked badge — every shipped artifact is a billboard back to ipop.ai

- **Status:** Accepted (Engine 1 of "make ipop EXPLODE", #399)
- **Date:** 2026-06-19
- **Context issue:** [#399](https://github.com/gagan114662/agent-skills/issues/399) — ipop has the machinery
  to ship real artifacts (published pages #231/#295, on-site PRs #250/#364) and the machinery to attribute a
  Stripe dollar back to the artifact that caused it (#386, ADR-0386), but nothing turns a shipped artifact
  into *distribution*. Each page the fleet ships is a dead end: it sells the customer's product, never ipop.
- **Builds on:** [ADR-0386](0386-attributed-revenue-ledger.md) (the tracking-ref mint + UTM stamping +
  exposure→receipt chain — reused verbatim; the badge link IS a #386 tracked URL), [ADR-0295](0295-deliverable-delivery.md)
  (the channel adapters that ship deliverables — the badge is appended at those adapter boundaries),
  [ADR-0364](0364-one-real-marketing-action.md) (the site-PR channel — the first real on-site ship),
  [ADR-0200](0200-premortem-panel.md) (standing rails —13 approval queue, content is DATA, owner-first).

## Context

The compounding-distribution loop: a fleet artifact ships → it carries a "Built with ipop" badge → a reader
clicks the badge → lands on ipop.ai → (some fraction) signs up → that customer's fleet ships more
badged artifacts. Every published page becomes a self-distributing seed, and because the badge link is a
#386 tracked URL, the entire loop is **measured**: the click is an attributable exposure (artifact → exposure
→ signup → payment), so we can rank artifacts by the *downstream revenue their badges caused* (the L3
revenue-weighted outcome from ADR-0386). This is the PageRank-style network effect: more artifacts → more
inbound links to ipop.ai → more signups → more artifacts.

The keystone gap was simply that no artifact linked back to ipop. Everything else already existed.

## Decision

Add a small **pure** badge generator and inject it at the two ship seams that produce reader-facing
artifacts — **gated by the existing `attribution` flag** (ADR-0386: default-OFF, owner-workspace-first). No
new config block, no new money/irreversible action, no migration.

- `attribution/badge.ts` (pure, no IO/clock/random):
  - `buildAttributionBadge({workspaceId, artifactId, channel, format, baseUrl?, utmSource?})` mints a #386
    tracking ref (`mintTrackingRef`) and a tracked URL (`buildTrackedUrl`) to `baseUrl ?? https://ipop.ai`
    with utm `{source: utmSource ?? "builtwith", medium: "badge", campaign: channel}`, and returns a
    "Built with ipop" snippet in `html` (escaped `<a … rel="noopener">` in a `<footer>`), `markdown`
    (`[Built with ipop](url)`), or `text` (`Built with ipop: url`).
  - `appendBadge(content, badge, format)` appends with the right separator: before the last `</body>` for
    html (else end-appended), a trailing blank line for markdown/text.
- **Injection point 1 — `delivery/adapters.ts` `SitePrChannelAdapter`** (the #364/#250 on-site PR path):
  when attribution is active, a markdown badge is appended to the committed file `content` before the
  publisher commits it. The publisher slugs the title into a `.md` content file, so markdown is the format.
- **Injection point 2 — `delivery/adapters.ts` `PublishChannelAdapter`** (the #231/#295 live-page path): when
  attribution is active, an html badge is inserted before `</body>` in the page rendered by `draftToHtml`.
  `draftToHtml` stays **pure** (no workspace context); the gate lives at the adapter boundary via an injected
  `AttributionBadgeFor` seam.
- **The gate** is `attributionActive(resolveAttributionCaps(loadConfig(workspaceId).attribution), workspaceId)`,
  resolved in `delivery/default.ts` (`resolveBuiltWithBadge`) and passed into both adapters. With the flag
  OFF — the default and current prod state — the seam returns `null` and the artifact is **byte-for-byte
  unchanged**.

## Consequences

- **Default behavior is unchanged.** The badge appears only once the owner enables attribution for their
  workspace. Off ⇒ no badge ⇒ identical bytes (covered by the off→original / on→original+badge test).
- **No new action / money / irreversible path.** The badge only appends our own footer to artifacts the
  fleet *already* ships through the existing #13-approved, gated delivery paths. The #13 approval queue is
  untouched; nothing new is gated because nothing new is shipped.
- **#200 trust boundary.** The badge is ipop's own fixed-voice content ("Built with ipop"); the URL is our
  OWN minted #386 ref pointed at our OWN domain — no untrusted artifact text ever flows into the link or the
  label. The html badge HTML-escapes the (already-our-own) URL defensively.
- **Measurement is free.** Because the link is a #386 tracked URL, an inbound badge click recovers the
  tracking ref (`recoverTrackingRef`) and becomes an attributable exposure — the same ledger (ADR-0386)
  measures the loop. This is the signal the learning loop (#390/#283) needs to fund the artifacts whose
  badges actually drove revenue.

## Alternatives considered

- **Inject inside `draftToHtml`.** Rejected: `draftToHtml` is a pure renderer with no workspace context;
  making it read config would make it impure and couple it to the attribution flag. The gate belongs at the
  adapter boundary (which has `workspaceId`).
- **A standalone "badge action" through #13.** Rejected: appending our own footer to an already-approved,
  already-shipping artifact is not a new outward action — it carries no new money/irreversible risk, so a new
  gate would be ceremony. The existing attribution flag is the correct, owner-first switch.
