# ADR-0243: Approval gates = MONEY ONLY; everything else fully autonomous

- **Status:** Accepted (owner decision — gagan, 2026-06-14)
- **Date:** 2026-06-14
- **Context issue:** [#243](https://github.com/gagan114662/agent-skills/issues/243)
- **Supersedes (for approval purposes):** the "sensitive-by-default / nothing leaves the building without your yes" stance of [ADR-0013](0013-approval-gates.md); the irreversible-as-human-gated reading of [ADR-0200](0200-premortem-panel.md). Those mechanisms remain — only the **gating predicate** narrows.

## Context
The fleet earns its keep by shipping work, not by parking it. Under the prior policy almost every outward action (`external.send`, `outreach.send`, `realworld.publish`, `venture.deploy`, `portfolio.sunset`, `dr.restore`, `autonomy.complete`, an agent-browser click, connecting any external account) was sensitive-by-default and paused for the owner. That made the owner the bottleneck on routine, reversible work. The owner's explicit decision (#243): **only the movement or commitment of real money needs a human yes.** Everything else the fleet manages autonomously. The security/compliance safeguards that are NOT approval gates stay on and run automatically.

## Decisions
1. **One MONEY predicate drives approval, not the broad sensitive/irreversible sets.** `evaluatePolicy` gates a no-rule action iff `isMoneyAction(actionType)` **or** the action commits real spend (a positive `amount`). `MONEY_ACTIONS` is the single source: `billing.refund/payout/transfer`, `finance.disbursement`, `venture.domain_purchase/ad_spend/payment_method`, `monetization.activate_price/payout_settings`, and `setup.external_account` (money only for the `payment` service kind — see §3). `DEFAULT_SENSITIVE_ACTIONS` is retained as a name (the #119 invariants derive from it) but now equals `MONEY_ACTIONS`. `IRREVERSIBLE_ACTIONS` narrows to the money-irreversible subset (the founder report's money-exposure count).
2. **Everything non-money is autonomous.** Removed from the gated set: `external.send` (non-paid), `outreach.send`, `realworld.publish`, `venture.deploy`, `venture.bootstrap`, `portfolio.sunset`, `dr.restore`, `autonomy.complete`, `browser.action`. They execute with no owner prompt. A cautious workspace can still opt any one back into a gate with an explicit `approval_policies` rule (the rule branch is unchanged).
3. **"Any real spend" is money even on a generic action type.** A marketing `ad.spend` rides `external.send` with the budget in `amount`; a positive `amount` with no rule gates by default. The workspace spend cap (`maxAutoAmount`) is kept — it auto-approves small spends under a ceiling and re-gates over it. For external-account onboarding, only the `payment` service kind (connecting LIVE payment credentials) parks an approval; every other connect (hosting/ESP/registrar/analytics/ads) is autonomous (it still shows on the setup checklist as a human paste-the-key step — that is a physical step, not an approval gate). Decided per-kind in `onboarding/service.ts` via `isMoneyServiceKind`.
4. **The non-approval safeguards are KEPT and automatic (no owner prompt).** These are security/compliance, not gates, and are untouched:
   - the **#223 injection-quarantine** (`decision-maker/quarantine.ts`) — poisoned web/LinkedIn content can never trigger an autonomous send/action (structural: the reader exposes no send/spend);
   - **email opt-out / suppression / CAN-SPAM/GDPR** (`acquisition/compliance.ts`) — enforced on every send;
   - **per-domain send rate caps / warmup** (`acquisition/compliance.ts`, `outreach/caps.ts`) — deliverability throttle;
   - the **#151 egress allowlist** still blocks a disallowed `external.send` in the executor (proven: an autonomous send to a non-allowlisted domain fails 502 and records a violation, no owner prompt);
   - the **#174 agent-browser runtime gate** (`decideBrowserStep` → `needs_approval`) still pauses a side-effectful remote mutation (a click that submits/posts/purchases), independent of the money policy.

## Consequences
- The owner sees only money decisions in the queue, each with the exact amount. The fleet ships drafts, posts, publishes, and deploys on its own.
- `dr.restore` and `portfolio.sunset` are now autonomous by default (they are not money). This is a deliberate part of the owner's money-only decision; a workspace that wants them gated adds a one-line policy rule.
- Copy across the console + brief composer (and the load-bearing public trust claims) now reads "only money needs your yes — the fleet ships everything else on its own" (all via `brand.ts`).

## Verification
Real-Postgres integration + unit suites prove, with no owner prompt: a money action (e.g. `billing.refund`, an `ad.spend` carrying `amount`) is gated with the exact amount; a non-money action (publish / non-paid send / sunset) executes autonomously; an injection-triggered send stays blocked; an opted-out recipient is auto-suppressed; a disallowed egress send is blocked + recorded. Gates green: tsc, eslint, build, server+web vitest, skill-colocation.
