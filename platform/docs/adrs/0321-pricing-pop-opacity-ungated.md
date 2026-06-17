# ADR-0321: The pricing pop is a pure transform — a plan card's visibility never depends on the animation

- **Status:** Accepted (shipped in PR for #321)
- **Date:** 2026-06-17
- **Context issue:** [#321](https://github.com/gagan114662/agent-skills/issues/321) — the in-app Upgrade
  modal ("Pick your pop. Three ways to hire a team of agents that actually ships.") still rendered **only
  the Starter ($49/mo) card**; Pro ($199) and Agency ($499) were blank space. A direct conversion/revenue
  blocker — the customer cannot see or choose a higher tier, and the page looks broken/untrustworthy.
- **Builds on / supersedes the reasoning of:** [ADR-0234](0234-pricing-modal-tier-visibility.md) (the first
  pass at this symptom) and [ADR-0125](0125-pricing-plans.md) (the pricing table + Stripe checkout where the
  pop entrance originated).

## Context

The modal is `PricingPanel` → `PricingTable`, rendered inside a `ShellOverlay` (`ConsoleView`), cards laid
out by `.pricing__grid` as `grid-template-columns: repeat(3, 1fr)`. The fingerprint — three cards in the
DOM, only the first painted, **empty space to the right** — is unchanged from #234: cards that occupy their
grid tracks but are not painted (`opacity: 0`).

### Why #234 did not fully close it (production-grounded, FM#2)

The end-to-end render path is, and was, **correct**: the server `billing/plans.ts` catalog always returns
all three plans, the `/workspaces/:wid/billing/plans` route serializes all three, the web API client passes
them through untouched, and the pure `PricingTable` maps over every plan (its unit test renders 3/3). The
data was never the bug.

ADR-0234 correctly removed the **resting** `opacity: 0` (`.pricing-card--pop { opacity: 1 }`) and kept the
pop via `animation: pricing-pop … both`, with the hidden start living only in the keyframes:
`@keyframes pricing-pop { 0% { opacity: 0; … } … }`. Its consequences section claimed: *"If the animation
never completes … the resting state is already `opacity: 1`, so all three tiers are visible."*

That reasoning has a hole, and #321 fell through it. Each card carries a **staggered `animation-delay`**
(`i * 90ms`, set inline in `PricingTable`). With `animation-fill-mode: both`, the **backwards** fill applies
the **first keyframe** — `0% { opacity: 0 }` — to the element **during its delay window, before the
animation starts**. So:

- **Starter** (card 0, delay `0ms`) has no backwards window → it always paints. It showed alone.
- **Pro / Agency** (cards 1–2, delay `90ms` / `180ms`) sit at `opacity: 0` for their delay. If the entrance
  animation is then **dropped rather than merely delayed** — browsers can skip CSS animations on nodes that
  are inserted into a not-yet-painted / offscreen subtree, which is exactly the modal's async, post-fetch,
  overlay-paints-on-open mount path — the backwards fill is never released and the card **sticks at
  `opacity: 0` permanently**.

`both` solved the *resting* (post-animation) state but left the *pre-animation* (`backwards`) state at
`opacity: 0`. The resting state is only reached **if the animation runs**. #234 designed out one of the two
hidden states; #321 is the other one.

## Decision

**A plan card's visibility must never be a function of the entrance animation — in any phase: delay,
running, or dropped. The pop becomes a pure transform.**

`opacity` is removed from `@keyframes pricing-pop` entirely; the keyframes now animate only `transform`:

```css
.pricing-card--pop {
  opacity: 1;                /* the only thing that sets opacity — always 1, in every phase */
  animation: pricing-pop 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes pricing-pop {
  0%   { transform: scale(0.92) translateY(8px); }
  60%  { transform: scale(1.03) translateY(0); }
  100% { transform: scale(1) translateY(0); }
}
```

- **During the delay** (backwards fill): the card is at `scale(0.92)` but `opacity: 1` → **visible**.
- **Running:** the bouncy scale/translate pops in exactly as designed.
- **Dropped** (the bug's trigger): the card stays at `scale(0.92)`, slightly smaller, but **fully visible**.

There is no phase in which `opacity` is anything but `1`. The pop is now strictly progressive enhancement,
never a gate — which is what #234 intended but could not guarantee while the keyframe still drove opacity.
The `prefers-reduced-motion` override (`opacity: 1; transform: none; animation: none`) is unchanged and
stays consistent. This reuses existing seams only — `PricingTable`, `.pricing__grid`, and the
`billing/plans.ts` catalog. No new component, no data change.

### Honoring the #200 premortem

- **Production-grounded (FM#2):** the diagnosis is traced through the real render path (catalog → route →
  client → component all return/​map 3 plans), and the residual hidden state (`backwards`-fill `opacity: 0`)
  is identified in the actual stylesheet rather than assumed.
- **No new capability, so no flag (FM#5, owner-attention):** this is a render-correctness bugfix. A bugfix
  must be on by default — gating "render all three plans" behind a default-OFF flag would ship the bug. No
  new behavior, data path, table, or money path is introduced, so there is nothing to gate owner-first.
- **External receipts for priced/checkout state (FM#2/#4):** the "Choose" CTA still routes through the
  untouched `PricingPanel.choose` → `#125` checkout seam. A plan is only ever activated by a
  **signature-verified Stripe webhook** (the external receipt) — never by anything this change touches.
- **Irreversible actions human-gated (FM#4):** money is INBOUND only, via the customer's own click into
  hosted Stripe checkout; outbound money stays #13-gated. Byte-for-byte unchanged here.
- **Injection defense (FM#6):** plan name/price/highlights are server-side constants from `billing/plans.ts`,
  not user- or agent-supplied input. No new untrusted string is rendered; no new injection surface.

## Consequences

- **No migration, no schema, no new table, no flag.** A keyframe edit (drop two `opacity` lines) plus tests
  and this ADR. Colocation stays green (no metric surface changed).
- **Revenue ladder restored and pinned by tests that would have caught #321.**
  - `PricingTable.visibility.test.ts` gains the stronger invariant: `@keyframes pricing-pop` **must not
    declare `opacity`** — visibility can never depend on the animation in any phase. (jsdom cannot compute
    animations, so the invariant is asserted against the stylesheet source, like `brand.test.ts`.) The
    existing "rests visible" and "keeps the pop entrance (`backwards`/`both`)" assertions still hold.
  - `PricingPanel.test.tsx` gains a render-seam test: fed the **full** catalog, the panel renders **≥3**
    plan cards, each with a price and an enabled "Choose" CTA. This closes the gap that let the bug hide —
    the panel's prior test fixture returned a **single** plan, so it could never have caught a
    fewer-than-all-tiers render.
- **Residual:** the exact modal-mount timing that drops the animation in production was not reproduced
  headlessly (the modal is auth-gated). As in #234, the fix removes the *dependency* (opacity ↔ animation)
  rather than the specific trigger, so it holds regardless of which condition fires. A live screenshot of
  the three-card modal should be captured on the next deploy.
