# ADR-0727: Autonomy by default — money is the only hard gate

- **Status:** Accepted (shipped in working tree as the `autonomy-defaults` policy library)
- **Date:** 2026-06-22
- **Context:** Every agent capability shipped "Off — switch it on to work" (the #284 Agent Garden default-OFF
  per-agent state) and senders were gated behind "Needs your approval" (the garden `external_send` enable gate +
  the connections approval message). That contradicts the product promise — the homepage FAQ says everything
  except money ships on its own — and makes the product feel like a cheap MVP with heavy setup friction. Issue
  #727 inverts the default: ALL capabilities ON out of the box, and the ONLY hard, code-enforced approval gate is
  money/spend.
- **Builds on:** [ADR-0243](0243-money-only-approval.md) (the money-only #13 gate — this generalizes it from a
  single approval path to the product-wide DEFAULT), [ADR-0403](0403-autonomous-send-within-caps.md) (sends are
  already autonomous under money-only governance; this aligns the rest of the surface with that stance),
  [ADR-0035](0035-config-layering.md) (env-resolved default flags), [ADR-0200](0200-premortem-panel.md) (the
  standing premortem: §4 irreversible-must-be-bounded, §6 untrusted content never drives an autonomous write —
  answered here by keeping the three always-on guards orthogonal and non-toggleable). Mirrors the self-contained,
  conflict-free module shape of the #592 kill-switch / #670 action-gate / #674 content-guard.
- **Scope:** a new self-contained `autonomy-defaults/` policy library — a pure money classifier (`classifyMoney`),
  the pure decision (`decideAutonomy`), the all-ON capability/channel defaults (`AUTONOMY_DEFAULTS_ALL_ON`), and
  an env-resolved opt-out (`resolveAutonomyCaps`). **Out of scope:** the Settings visuals (separate issue #728);
  any DB migration / schema barrel / app-wiring registry change; rewiring existing actuators — the consumption
  seam (garden enable, sender actuators, the connections approval copy) adopts this policy in a follow-up, exactly
  as the kill-switch deferred its admission-chokepoint wiring.

## Context

The friction is two concrete defaults: (a) the garden's per-agent state defaults to `disabled` ("Off — switch it
on to put it to work"), and (b) enabling an `external_send` agent always routes to an owner approval. Both
predate the money-only stance the rest of the platform already adopted for *actions* (#243, #280, #403). The fix
is to make money-only the product-wide DEFAULT and express it as one authoritative, testable policy rather than
re-deriving it at each call site.

This is the deliberate INVERSION of the fail-closed safety classifiers (#670 action-gate, #674 content-guard):
those gate everything public/irreversible/uncertain. The autonomy-defaults policy gates ONLY money — drafts,
publishing, non-paid outreach, deploys, and even money-free destructive ops run autonomously by default, which is
the whole point of the issue. The fail-closed safety layers remain available where a deployment opts into them;
the three always-on guards below are never weakened.

## Decision

1. **Pure money classifier — `autonomy-defaults/money.ts`.** `classifyMoney(action) → {isMoney, signals, reason}`.
   `isMoney` is true only for a money/spend action: an explicit `money` / `paidAdSpend` / `connectsLivePaymentKey`
   flag, a money-movement verb token (`charge`, `refund`, `payout`, `withdraw`, `pay`, …), real ad spend (an ad
   token + a spend token), or connecting a LIVE payment key (a connect token + a payment surface + a `live`
   marker). Ambiguous verbs (`transfer`, `capture`, `settle`) are deliberately NOT money verbs — over-gating a
   money-free action would defeat autonomy; a genuinely-money ambiguous call passes `money: true`. Pure + total.

2. **Pure decision — `autonomy-defaults/policy.ts`.** `decideAutonomy(action, caps) → {mode, gate, …}` where
   `mode ∈ {"autonomous","gated"}`, in order: money ⇒ `gated/money` (the one hard, non-toggleable gate, checked
   first and unconditionally); a deliberately dialed-off capability ⇒ `gated/capability_disabled`; a dialed-off
   channel ⇒ `gated/channel_disabled`; otherwise ⇒ `autonomous/none` (the default). The capability is inferred
   from the verb when not given. There is NO path from a money action to "autonomous".

3. **All-ON defaults + env opt-out — `defaults.ts` / `caps.ts`.** `AUTONOMY_DEFAULTS_ALL_ON` enables every
   capability (`draft`, `publish`, `outreach`, `deploy`) and channel (`email`, `sms`, `social`, `slack`, `dm`,
   `voice`, `push`, `web`). `resolveAutonomyCaps(env)` applies the all-ON default and dials individual toggles OFF
   from `AUTONOMY_DISABLE_CAPABILITIES` / `AUTONOMY_DISABLE_CHANNELS` (comma/space lists; unknown names ignored).
   Money is NOT in this set — no env can turn a money action autonomous.

4. **Always-on guards stay orthogonal — `ALWAYS_ON_GUARDS`.** The kill-switch (#592), suppression / opt-out / DNC
   (#594), and anti-injection (#674) are named as always-on and are NOT opt-out toggles; a caller runs them
   independently of, and they are never weakened by, this decision.

## Consequences

- **Money is the only hard gate, by default.** A fresh or existing workspace has all capabilities ON and produces
  work with zero switch-flipping; only money pauses for a recorded approval. Proven by
  `test/unit/autonomy-defaults.test.ts` ("money gated, everything else autonomous").
- **Dial-down, never dial-up.** An opt-out toggle can only ADD gating to a single capability/channel; it can never
  relax money (money wins over a dialed-off capability in the test matrix).
- **Self-contained / conflict-free.** Env-only config, no migration, no schema barrel, no app-wiring registry edit
  — a pure library other code calls, the #592 / #670 / #674 pattern.
- **Settings visuals + actuator wiring are follow-ups** (#728 and a consumption-seam change), so this change is
  purely the authoritative default-flag + data layer the issue asked us to own.
