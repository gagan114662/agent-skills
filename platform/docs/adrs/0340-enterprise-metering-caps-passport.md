# ADR-0340: Enterprise layer — per-agent/per-customer metering, hard budget caps, Passport-style IdP gate

- **Status:** Accepted (shipped in PR for #340)
- **Date:** 2026-06-18
- **Context issue:** [#340](https://github.com/gagan114662/agent-skills/issues/340) — build the governance +
  cost-control layer that lets ipop sell the fleet, modeled on Vercel Ship 26's "Enterprise Apps & Agents"
  (metering, budget caps, Passport IdP gating). See `SHIP26_TO_IPOP_INTEGRATION_PLAN.md` §5. Feeds
  monetization [#188](https://github.com/gagan114662/agent-skills/issues/188) (which waits on finance
  [#194](https://github.com/gagan114662/agent-skills/issues/194)) and hardens the v5 console for external
  customers.
- **Builds on:** [ADR-0243](0243-money-only-approval.md) (the money-only #13 gate — a budget breach is the
  one new money action), [ADR-0194](0194-finance-ledger.md) / finance ledger + [#188](https://github.com/gagan114662/agent-skills/issues/188)
  monetization (the billing/finance seams this feeds — NOT a parallel billing system), [ADR-0267](0267-central-provisioning.md)
  (the metering+caps+default-OFF module idiom this mirrors, and `provisioning.customer_spend` whose caps this
  backs), [ADR-0189](0189-acquisition-execution.md) (the owner-approved budget-envelope pattern), [ADR-0035](0035-config-layering.md)
  (layered feature flags), [ADR-0200](0200-premortem-panel.md) (the standing premortem this answers to),
  [ADR-0099](0099-disaster-recovery.md) (migrations numbered by issue #).
- **Scope (slice 1):** per-agent + per-customer **usage metering** with verifiable receipts; a hard per-agent
  + per-customer **budget cap** the system never crosses (also backing bid's money caps); a **Passport-style**
  IdP/SSO gate for the v5 console + department agents. **Out of scope:** BYOC; any real billing/payment
  provider; any money movement. Live billing/enforcement stays owner-gated behind the flag.

## Context

ipop's pitch is "build to sell the build" — a customer runs the whole fleet. That needs a trust + billing
story: the customer must be able to SEE what each agent costs, the system must never overspend a budget on
its own, and nothing internal may be publicly reachable. Vercel Ship 26 ships exactly these primitives
(metering, budget caps, Passport). The premortem (#200) makes the requirements sharp: self-reported numbers
are fiction (§2), irreversible money must be pre-committed not post-hoc (§4), and provider/usage/billing
inputs are untrusted (§6).

The repo already has the billing/finance/monetization seams (`src/billing`, `src/finance`, `src/monetization`,
the #13 approvals queue). This work does NOT invent a parallel billing system — it adds the cost-control +
access layer that feeds them, in the established pure-core + caps + service + default idiom of #267.

## Decision

A new `src/enterprise/` module, default-OFF and owner-workspace-first, with three pure cores wired through one
service:

1. **Metering (`metering.ts`).** `buildUsageReceipt` shapes a `UsageMeasurement` (workspace = customer, agent
   = department, kind = model/tool/action, units, costCents, optional `externalRef`) into a `UsageReceipt`.
   Per premortem §2, `verified`/`provenance` are **DERIVED** from a non-empty external receipt — never a
   caller field — so an agent can never self-assert a billable number; `verifiedCostCents` and the read
   surface sum only verified rows. `aggregateByAgent` / `aggregateByCustomer` give the per-agent and
   per-customer surfaces. Provider free text is sanitized (§6) and numbers clamped non-negative finite.

2. **Budget caps (`budget.ts`).** `decideSpendAgainstCaps(caps, requestCents)` is a HARD never-exceed
   decision over the applicable caps (the customer cap AND the spending agent's cap). A spend that fits is
   allowed autonomously inside the pre-committed envelope; a spend that would exceed ANY cap is **blocked**
   and routed to the owner — there is no "allowed AND over a cap" outcome, so the system never crosses a cap
   on its own (§4). This is the gate that **backs bid's money caps**: bid asks before any ad spend. Numbers
   are normalized fail-closed (§6): a poisoned non-finite cap blocks everything; a negative committed counter
   clamps to 0; an indeterminate request never auto-spends.

3. **Passport (`passport.ts` + `passport-gate.ts`).** `decidePassport` admits a caller only when an
   authenticated session carries a **verified** assertion from an **allow-listed** IdP; otherwise it denies
   (`unauthenticated` / `sso_required` / `forbidden_idp`). The provider name is untrusted, matched with strict
   normalization + a conservative character whitelist (§6), and `verified` must be a trusted server-side fact.
   The Fastify hook composes this over the existing `resolveIdentity` guard; default-OFF makes it a no-op, so
   existing auth is unchanged until an owner enables it — and the default assertion resolver returns null, so
   an owner who enables the gate before wiring a real IdP resolver gets a fully-dark surface (fail-closed).

A budget breach is the single new approval action, `enterprise.budget_breach`, added to both `MONEY_ACTIONS`
and `IRREVERSIBLE_ACTIONS` (raising/allowing spend over a pre-committed cap is itself an irreversible money
decision). The service parks a PENDING request the owner approves through the #13 queue; the executor is
recorded-only — this slice moves no money.

### Why default-OFF, owner-workspace-first

The live metering, cap-enforcement, and IdP-gating paths are all flag-gated (`enterprise.enabled`,
`enterprise.passportEnabled`), enabled for the owner workspace first (`RELOAD_ENTERPRISE_*` / managed layer).
With no config the layer meters nothing live, enforces no cap, and the Passport gate is open. This matches the
premortem's reversibility discipline and the issue's "build + PR only; live billing stays owner-gated".

## Alternatives considered

- **Reuse `provisioning.customer_spend` for the breach instead of a new action.** Rejected: a cap breach is a
  distinct, first-class owner decision ("raise/allow this over-spend") that must be surfaced and testable in
  isolation; folding it into the per-call spend action would hide the cap event.
- **Enforce caps against verified spend only.** Rejected for the cap path: a never-exceed safety cap must be
  conservative and count committed spend, or unreceipted spend could slip over. Metering keeps the verified
  vs. estimated split (§2) for the billing read; the cap is the safety limit.
- **A new billing system.** Explicitly rejected by the issue — this feeds #188/#194, it does not replace them.

## Consequences

- The fleet gains a per-agent + per-customer cost surface and a hard budget cap that backs bid's money caps,
  with every billable number grounded in an external receipt.
- One new money action (`enterprise.budget_breach`) — the pinned MONEY array test is updated in lockstep.
- New tables `enterprise_usage` + `enterprise_budget_caps` (migration 0340), named to avoid the #155 governed
  metric-surface gate. No money moves; live billing + a real IdP assertion resolver are owner-gated follow-ups.
