# ADR-1489: First-class auth routes and browser-native pricing CTAs

- **Status:** Accepted
- **Date:** 2026-07-02
- **Context issue:** [#1489](https://github.com/gagan114662/agent-skills/issues/1489)
  (P0: pricing CTAs do not reach a working signup or checkout)
- **Recurrence of:** [#1457](https://github.com/gagan114662/agent-skills/issues/1457)
  (`/signup` has no form) and [#1459](https://github.com/gagan114662/agent-skills/issues/1459)
  (`/login` has no form) — both closed, then reported again as #1489.
- **Behaviour fix landed in:** [#1490](https://github.com/gagan114662/agent-skills/pull/1490)
  ("Fix pricing signup checkout handoff"). This ADR ratifies the convention that fix
  established and adds the missing end-to-end regression guard.
- **Builds on:** [ADR-0125](0125-pricing-plans.md) (pricing plans),
  [ADR-0300](0300-low-commitment-signup-entry.md) (signup entry),
  [ADR-0402](0402-attribution-through-checkout.md) (plan → checkout handoff).

## Context

The single revenue path is `/pricing` → plan CTA → `/signup?plan=…` → post-signup Stripe
checkout. It has broken three times (#1457, #1459, #1489) with the same shape: the buyer
lands on the iMessage workspace room instead of a signup form or checkout, so self-serve
purchase dead-ends. Two independent regressions produced that shape:

1. **Auth routes fell through to the app shell.** The web app uses a tiny dependency-free
   client router (`routing.tsx`) with no route table; `AuthGate` decides the screen by
   `phase` (`loading` / `anon` / `ready`) and path. `/login` and `/signup` were matched
   *after* the `phase === "ready"` early-return, so any visitor whose session resolved to
   `ready` (a returning cookie holder) got `children` — the workspace room — at those URLs
   rather than an auth or checkout screen.

2. **The pricing CTA depended on the SPA click handler.** The CTA was a client `<Link>`
   that `preventDefault`s the click and calls `navigate()`. When the prerendered
   (`renderToStaticMarkup`) `/pricing` page had not finished hydrating — or the handler was
   otherwise unhappy — the click was swallowed and the URL stayed on `/pricing`.

Production-grounded verification (premortem #200 FM#3) on 2026-07-02 against `ipop.ai`
running the fixed bundle (`reload-build-sha 03dce28f`) confirmed the current behaviour is
correct: clicking the Pro CTA navigates to `/signup?plan=pro&billing=month` and renders a
real signup form; direct `/signup` and `/login` render real forms; cookieless `/me` returns
`401` (a logged-out visitor is `anon`, not `ready`).

## Decision

**1. Auth routes are first-class, checked ahead of the phase gate, and never fall through to
`children`.** `/login` and `/signup` resolve deterministically for every phase:

- `anon` / `loading` / `offline` (logged out): render the real `AuthForm`.
- `ready` (logged in): render `SignedInAuthRoute` — an explicit "this browser is signed in"
  boundary with *Open agent room* / *View pricing* / *Sign out*, never the room at a
  `/login` or bare `/signup` URL. A `ready` visitor on `/signup?plan=…` is carried into the
  checkout handoff (`PostSignupCheckoutIntent`) instead.

**2. Pricing plan CTAs are browser-native anchors.** Each plan CTA is a plain
`<a href="/signup?plan=<key>&billing=<interval>">` — a full navigation the browser always
performs, independent of SPA hydration state. No client handler may `preventDefault` the
plan CTA. (Analytics may run on click, but must not cancel the navigation.)

**3. Checkout failure is a visible, actionable state.** A signed-in checkout that fails
renders `CheckoutIntentError` ("Back to pricing" / "Open agent room"), never a silent
fall-through to workspace content.

## Consequences

- The revenue path renders a form or checkout for both logged-out and returning visitors.
- The prerendered auth/pricing pages (`entry-server.tsx`) stay byte-aligned with the
  hydrated screens, so there is no flash of the wrong surface.
- Regression is guarded end-to-end: `App.test.tsx` renders the real `App` at `/pricing`,
  asserts the Pro CTA is a native anchor to `/signup?plan=pro&billing=month`, that the click
  is **not** cancelled (`fireEvent.click(...) === true`), and that following the href lands
  on the create-account form — never the `iMessage room` / `Marketing dashboard` surfaces.
  `AuthGate.test.tsx` covers the phase matrix (anon form, signed-in boundary, signed-in
  checkout handoff, checkout-failure state). A future change back to a client `<Link>` or a
  phase-ordering that fronts `children` fails these tests.

## Alternatives considered

- **Keep the client `<Link>` and fix only the ordering.** Rejected: the CTA is the one step
  that must survive a broken/half-hydrated SPA, so it should not depend on the SPA at all.
- **Redirect `ready` visitors off `/login` and `/signup` to the app.** Rejected in favour of
  the explicit `SignedInAuthRoute` boundary, which keeps *switch plans* / *sign out* reachable
  (a shared machine, a buyer wanting a different account) rather than bouncing silently.
