# ADR-0401: Trackable pay link in outreach — give the fleet's outreach a payable, measurable way to pay

- **Status:** Accepted (Leads Centre GAP 3)
- **Date:** 2026-06-19
- **Context:** `/tmp/leads-centre-gaps.md` GAP 3 — the autonomous lead→payment loop traces end-to-end EXCEPT
  the reached human is never given a way to pay. Outreach (#225) and reach (#280) compose a soft CTA
  ("Open to a 15-minute look?") but never a checkout/payment URL, so there is no button to click and no
  way to attribute the dollar back to the outreach that earned it.
- **Builds on:** [ADR-0386](0386-attributed-revenue-ledger.md) (the tracking-ref mint + UTM stamping +
  exposure→receipt chain — reused verbatim), [ADR-0399](0399-built-with-ipop-badge.md) (same pure
  tracked-URL pattern, applied to shipped artifacts), the #98 inbound-only `BillingProvider` seam, and
  [ADR-0200](0200-premortem-panel.md) (standing rails — #13 approval queue, content is DATA, owner-first).

## Context

The keystone gap is small: outreach composes a message but never a payable link. Everything else already
exists — the #98 `createPaymentLink` seam mints a hosted inbound collection URL; #386's `mintTrackingRef`
/ `buildTrackedUrl` stamp a ref into a URL; the exposure store records "artifact shown to the world". What
was missing was the glue that mints a **trackable pay link** for a lead and drops it into the body.

Minting a collection link is NOT money-out. The #98 billing seam is inbound-only by construction — it has
no `refund`/`payout`/`transfer` method — so this path cannot move money out. A charge only happens when a
human clicks the link and pays through the #98-owned Stripe rails; that money-out action stays #13-gated.
The link itself is an inert draft URL.

## Decision

Add a pure helper + a service seam + a default-OFF compose wiring. No migration (reuse `payment_links` /
`exposures`), no new money/irreversible action.

- `leads/pay-link.ts` (pure, no IO/clock/random):
  - `buildPayLinkSpec({workspaceId, leadOrArtifactId, channel}, {planId}, utmSource)` mints the #386
    ref (`mintTrackingRef`) and returns `{ trackingRef, metadata: {trackingRef}, utm }`. The ref rides in
    BOTH the metadata (round-tripped on the #98 webhook → GAP 2 can stamp it onto `revenue_events`) AND
    the URL.
  - `buildTrackedPayUrl(hostedUrl, spec)` wraps a raw hosted link via `buildTrackedUrl` (ref + utm in the
    query string; non-URL input returned unchanged — never corrupts the link).
- `leads/pay-link-service.ts` — `mintTrackablePayLink(deps, {workspaceId, planId, leadOrArtifactId,
  channel})`: resolves the plan/price, calls the injected inbound-only billing seam's `createPaymentLink`
  WITH the `{trackingRef}` metadata, records an attribution EXPOSURE (`artifactKind: "pay_link"`,
  idempotent on the ref), and returns the tracked URL + provider kind. Billing + attribution are injected
  seams, so unit tests run on fakes (no Stripe, no DB). With the `none` provider (default) the URL is a
  deterministic non-live placeholder; live collection needs `BILLING_PROVIDER=stripe` (set in prod).
- Compose wiring (`outreach/compose.ts` + `outreach/service.ts`): a new optional `payLinkUrl` on
  `ComposeInput` appends a single clean `Start here: <url>` line (scheme-validated http(s); appended after
  the prose cap so the URL is never truncated). The service gates this behind a new default-OFF
  `outreach.payLinkInOutreach` flag AND a wired `OutreachPayLinkMinter` seam — both absent in prod, so the
  composed body is byte-for-byte unchanged. Mint is best-effort: a failure or a `null` (unknown plan)
  yields no link, never a broken body. The SEND still parks at the #13 gate — minting the link ≠ sending.

## Consequences

- The fleet can now put a payable, trackable link in front of a human, and the ref rides in the URL AND the
  link metadata so GAP 2 (webhook → `revenue_events`) can attribute the payment.
- No money-out path is added (no charge/refund/payout); charges/payouts stay #13-gated.
- Default behavior is unchanged: flag-off / `none` provider / no minter ⇒ no pay link, identical body.

## Alternatives considered

- A whole new top-level config block: rejected as heavier than needed — outreach already owns an
  owner-gated `enabled` block; one optional default-OFF field on it is the smaller, cleaner slice.
- Composing the link in the pure `compose.ts` directly (calling Stripe): rejected — `compose.ts` is pure
  by contract; the Stripe call lives in the injectable service seam, and `compose.ts` only takes a URL.
