# ADR-0147: Default TRIAL scale caps — a usable free tier in the config base layer

- **Status:** Accepted (owner directive — urgent prod fix; **video gate waived by the owner**)
- **Date:** 2026-06-11
- **Context:** Live `ipop.ai` workspaces (fresh/owner) show `GET /workspaces/:wid/scale/usage` with
  `caps.tenantConcurrency: 0` and `caps.budgetCents: 0`. Caps are supposed to come from a billing plan,
  but plan→caps is not wired ([ADR-0125](0125-pricing-plans.md) §Consequences explicitly defers "wiring
  those caps back into the #71 admission chokepoint" to a follow-up). So **no** workspace has a real
  tier, and the product's free-tier story is "nothing, until checkout exists."
- **Builds on:** [ADR-0040](0040-cloud-scale.md) (the `[scale]` block, `resolveScaleCaps`, the admission
  chokepoint), [ADR-0035](0035-config-layering.md) (env < user < repo < managed layering; replace-not-merge).

## ⚠️ Decision first — where the free tier lives

**Put the trial free tier in the config *base* layer (env), default-ON, as the lowest-precedence
`[scale]` source.** Not a new admission code path; not a DB table; not a hard-coded constant in
`decideAdmission`. The free tier is *policy*, and policy already has a home: the layered config the
admission chokepoint and the usage dashboard both read (`loadConfig(wid).scale`). Making it the base
layer means:

- Every workspace gets it automatically, with **zero operator action** — the whole point, since checkout
  is not wired.
- A paid plan (a per-tenant managed `[workspace.<id>.scale]`) **fully replaces** it via the existing
  replace-not-merge layering — the same mechanism that will back checkout→caps when ADR-0125's follow-up
  lands. No second override path to reconcile.

## Decisions

### 1. `TRIAL_SCALE_DEFAULTS = { tenantConcurrency: 1, budgetCents: 500 }`
One live session at a time; a $5/window soft budget. `budgetCents` only bites once a
`computeRateCentsPerMinute` is configured (it defaults to 0 → estimated cost 0 → the budget never
blocks) — so it is a forward-looking guardrail that the usage dashboard can surface, not a blocker today.
`tenantConcurrency: 1` is the real, usable free-tier ceiling.

### 2. Default-ON — the one config block that is not opt-in
Every other config block (`venture`, `watchdog`, `marketing`, …) defaults **off** to preserve "do
nothing → today's behavior." Trial caps deliberately invert that: **off-by-default would mean a brand
new product with no free tier**, i.e. the platform is dead on arrival for anyone who hasn't paid through
a checkout that doesn't exist yet. The cost of being wrong is asymmetric — a too-generous default is a
one-line tweak; a missing default is "no one can use the product." So `CONFIG_DEFAULTS.scale` carries
the trial tier and the env base layer emits it unless explicitly disabled.

### 3. Tunable + disablable via `RELOAD_TRIAL_*` (env base layer)
- `RELOAD_TRIAL_TENANT_CONCURRENCY` / `RELOAD_TRIAL_BUDGET_CENTS` — override the numbers.
- `RELOAD_TRIAL_ENABLED=false` (or `0`) — emit an **empty** `[scale]` block, restoring the pre-#147
  unlimited default (`tenantConcurrency: 0` = unlimited in `decideAdmission`). An escape hatch for tests
  and for any deployment that wants the old behavior.

### 4. Honest note on the "caps are ZERO" symptom
`decideAdmission` treats a `0` cap as **unlimited** — so `caps: 0/0` does **not**, by itself, deny a
launch at the admission chokepoint. The real value of this change is (a) giving every workspace a
**real, visible, metered** free-tier ceiling instead of a confusing "0 = unlimited" that reads like a
lockout, and (b) being the **override target** a paid plan replaces. If an `@mention` still doesn't
launch after caps are non-zero, the next gate to check is the **#68 subscription-auth gate**
(a workspace with no Claude connected gets a "Connect Claude" reply and never launches a session) — that
is a separate, intended behavior, not a caps problem.

## Consequences
- **Positive:** A fresh/owner workspace has a usable, metered free tier the moment it exists — no plan,
  no operator config. The usage dashboard shows a real tier. Paid plans override it through the existing
  layering with no new code.
- **Negative / follow-ups:** Until ADR-0125's plan→managed-`[scale]` wiring lands, a *paying* customer
  would still see the trial `tenantConcurrency: 1` unless an operator writes a per-tenant managed
  override (which is exactly the immediate prod unblock used for the owner workspace). There are no
  paying customers yet (checkout is unwired), so this is acceptable; the proper fix is the deferred
  ADR-0125 seam, which will write the managed override automatically on activation.
- **Reversible:** `RELOAD_TRIAL_ENABLED=false` restores the prior unlimited-by-default behavior with no
  code change.
