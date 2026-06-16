# ADR-0234: Pricing cards rest visible — the Upgrade modal no longer hides Pro & Agency

- **Status:** Accepted (shipped in PR for #234, closes #287 as a duplicate)
- **Date:** 2026-06-16
- **Context issues:** [#234](https://github.com/gagan114662/agent-skills/issues/234) and
  [#287](https://github.com/gagan114662/agent-skills/issues/287) — the in-app Upgrade modal
  ("Pick your pop") visually rendered **only the cheapest Starter ($49) card**; Pro ($199) and Agency
  ($499) were present in the DOM (three "Choose" buttons, all three prices) but **invisible**, with empty
  space where the upsell tiers should sit. Found by dogfooding the live first-dollar path on ipop.ai.
- **Builds on:** [ADR-0125](0125-pricing-plans.md) (the pricing table + Stripe checkout, where the pop
  entrance animation originated) and the #214 public conversion funnel (PR #218, the dedicated
  `/pricing` page that reuses the same `.pricing__grid` markup).

## Context

The modal is `PricingPanel` → `PricingTable`, rendered inside a `ShellOverlay` (`ConsoleView`). The cards
are laid out by `.pricing__grid` as `grid-template-columns: repeat(3, 1fr)`.

The symptom — three cards in the DOM, only the first visible, **empty space to the right** — is the exact
fingerprint of cards that *occupy their grid tracks but are not painted*: `opacity: 0`. Starter (track 1)
showed; Pro (track 2) and Agency (track 3) held their cells but were transparent.

### Production-grounded verification (not an assumption)

Per the #200 premortem (FM#2 — never trust a self-reported, un-verified claim), the diagnosis was checked
against reality, not just read off local source:

1. **The grid itself is correct and works in production.** The public `/pricing` page uses the
   **identical** `<ul class="pricing__grid"><li class="pricing-card pricing-card--pop">` markup. Fetching
   `https://ipop.ai/pricing` live returns all three tiers — "Pro … $199/mo" and "Agency … $499/mo" both
   render. So `grid-template-columns: repeat(3, 1fr)` is **not** the bug, and #218 did **not** regress it.
2. **The remaining difference is per-card visibility.** `.pricing-card--pop` rested at `opacity: 0` and
   relied on the `pricing-pop` keyframe animation (with a staggered `animation-delay` of `i * 90ms` and
   `animation-fill-mode: forwards`) to flip each card to `opacity: 1`. Visibility was **gated on the
   animation completing for each card**.

The modal is the surface that trips this gate: unlike the public page (cards mount synchronously on
navigation), `PricingPanel` mounts the cards **after an async plan fetch** (a `PopLoader` shows first),
inside an overlay that paints on open. Any condition where the staggered entrance animation does not run
to completion for a delayed card — late mount, paint timing, background-tab throttling, an interrupting
re-render — leaves that card stuck at its `opacity: 0` resting state **permanently**, while it still
occupies its grid cell. The auth-gated modal could not be fetched headlessly to screenshot, so the fix is
deliberately **robust to the trigger rather than dependent on reproducing the exact timing**.

## Decision

**A plan card must be visible at rest. The pop is a progressive enhancement, never a gate on visibility.**

`.pricing-card--pop` now rests at `opacity: 1` with no resting transform; the hidden start state lives
*only* in the `@keyframes pricing-pop` (`0% { opacity: 0; transform: scale(0.92) translateY(8px) }`) and
is pre-filled via `animation-fill-mode: both`:

```css
.pricing-card--pop {
  opacity: 1;
  animation: pricing-pop 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
```

- **If the animation runs** (the common case): `both` pre-fills the `0%` keyframe during the delay, so the
  card still starts hidden and pops in exactly as before. The `100%` keyframe (`opacity: 1; transform:
  none`) matches the resting state, so `both` holding the end state produces no jump.
- **If the animation never completes** (the bug's trigger): the resting state is already `opacity: 1`, so
  **all three tiers are visible**. The failure mode is designed out, not merely papered over.

The `prefers-reduced-motion` override (`opacity: 1; transform: none; animation: none`) is unchanged and
remains consistent with the new resting state.

This reuses the existing seams only — the `PricingTable` component, the `.pricing__grid` markup, and the
`LANDING.plans` / `billing/plans.ts` pricing config. No new component, no new flag, no data change.

## Consequences

- **No migration, no schema, no new table.** A two-line CSS change plus tests + this ADR. Colocation stays
  green (no metric surface changed).
- **Revenue ladder restored.** A price-shopping visitor now sees Starter / Pro / Agency side by side; each
  "Choose" still routes to its own Stripe checkout via the untouched `PricingPanel.choose` → `#125` seam.
- **Checkout and approval gates untouched.** This is a visibility fix; the irreversible/owner-gated money
  path (Stripe checkout) is byte-for-byte unchanged, honoring #200 FM#4. No external/untrusted input is
  rendered (plan data comes from the server `listPlans` seam), so there is no new injection surface (FM#6).
- **Regression is pinned by a test that would have caught it.** `PricingTable.visibility.test.ts` asserts
  the stylesheet invariant directly (jsdom cannot compute animations): the card must not rest at
  `opacity: 0`, the entrance must still pre-fill its hidden start (`backwards`/`both`), and reduced-motion
  keeps every card visible. `PricingTable.test.tsx` additionally asserts an enabled "Choose" CTA for all
  three tiers.
- **Residual:** the exact modal-mount timing that tripped the gate in production was not reproduced
  headlessly (the modal is auth-gated). The fix removes the dependency rather than the specific trigger,
  so it holds regardless of which condition fired. Live screenshot proof of the three-card modal should be
  captured on the next deploy.
