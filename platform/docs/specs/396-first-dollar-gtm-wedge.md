# First-Dollar GTM Wedge (#396)

## Narrowest First Customer

The first paid ipop customer is a pre-seed or seed B2B founder with a small team, a working product, and an urgent need to turn a launch or dormant product into qualified conversations this week. The buyer is usually the founder, CEO, or head of growth.

Disqualify enterprise procurement cycles, consumer-only audiences without a clear buyer, and teams without a working product or checkout path.

## Fastest Honest Reach Path

The fastest honest channel is owner-reviewed outbound email with a checkout tracking ref. Until issue #395 enables a real live outbound channel, agents may only use owned/build-in-public posts or warm founder DMs; they must not fake sends or mark simulated connections as live outreach.

Backup channels, once permitted, are LinkedIn through a permitted API sender and a build-in-public launch post that points to the same tracked checkout path.

## Offer

Position ipop as a 48-hour first-customer sprint:

- ICP and channel hypothesis for one narrow buyer.
- 25 sourced prospects with cited external signals.
- Owner-reviewed outbound copy.
- Live checkout tracking.
- A receipts report that separates external proof from internal dogfood.

## One-Week Success Metric

Success is one real external signup that reaches Stripe checkout within seven days, attributed with an `ipop-first-dollar-*` tracking ref. Internal dogfood, previews, mock OAuth, and untracked page views do not count.

## Agent Rules

Agents should lead with the founder's immediate revenue job, not a broad autonomous-company-platform story. Owned-surface positioning can publish autonomously; direct outbound waits for the live-channel gate. Money-out, paid lists, ads, and customer spend remain approval-gated.

The executable artifact lives in `platform/apps/server/src/gtm/first-dollar-wedge.ts` so the fleet can reuse the wedge instead of re-deriving it from prose.
