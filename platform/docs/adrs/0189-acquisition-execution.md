# ADR-0189: Acquisition execution — the fleet runs real campaigns, not plans

- **Status:** Accepted (shipped in PR for #189)
- **Date:** 2026-06-13
- **Context issue:** [#189](https://github.com/gagan114662/agent-skills/issues/189)
- **Answers to:** [#200](https://github.com/gagan114662/agent-skills/issues/200) (the standing premortem —
  "plans are not customers"; every roadmap item must answer its failure modes; see "Premortem" below).
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the `external.send` action + `evaluatePolicy` +
  recorded-only executor this makes *execute*), [ADR-0123](0123-marketing-department-fleet.md)
  (`buildMarketingSend` — the `social.post`/`email.send`/`ad.spend` descriptors),
  [ADR-0192](0192-external-account-onboarding.md) (the write-only credential vault every real provider
  connects through), [ADR-0151](0151-ona-governance-trust.md) (the `EgressEnforcer` send chokepoint this
  slots beside), [ADR-0173](0173-founder-briefings.md) (the daily
  brief CAC + spend report into), [ADR-0174](0174-agent-browser-runtime.md) (browser actions stay
  approval-gated — never an autonomous write), [ADR-0099](0099-disaster-recovery.md) (by-issue migration
  numbering).

> **Numbering note.** Migration + ADR use the `0189` slot (the issue number), per the by-issue convention
> (ADR-0099's note), to dodge sibling-workspace collisions in the shared sequence.

## Context

The owner directive is blunt: **bid plans spend and echo queues posts, but nobody can actually pull the
levers** — ads never run, emails never send, posts need hand-carrying. Every outbound action is an
`external.send` #13 approval that, even once approved, is **recorded-only** (ADR-0013 §2): the executor
confirms the action *would* have gone out and performs no network egress. Plans are not customers (#200).

But "make it send" cannot mean "let agents send freely". The premortem (#200) sets the boundaries:

- **§4 reversibility.** Email deliverability, ad money, and brand are **irreversible**. An irreversible
  action may only be autonomous inside a **pre-commitment constraint** (a budget cap, a daily send cap) —
  otherwise a human decides. SEO publishing to our own site is reversible, so it can be fully autonomous.
- **§6 injection defense.** A web-reading agent's draft can be poisoned by the page it read; a poisoned read
  must **never** steer an autonomous write. Web-read provenance is quarantined from auto-send.
- **§2 metrics are fiction.** CAC and conversions in the brief must be **external receipts** (what the
  provider charged, what an external event confirms), never a self-reported number.

## Decision

Add an **`acquisition/` feature** that turns the approved `external.send` into a real ads/email/social/SEO
send, with the guards enforced in code. **Default-OFF** behind an `acquisition` config block (master flag +
per-channel flags, owner-workspace-first); a real send additionally requires the owner to have **connected
the provider** in the #192 vault. With the flag off the `external.send` executor is byte-for-byte today's
recorded-only behavior.

1. **Pure decision core (`decide.ts`).** `decideSpendWithinEnvelope` (AC1 — the owner-approved budget
   envelope *is* the money decision; optimizations inside it are autonomous, over it needs the owner);
   `decideSendGate` → `auto | approval | blocked` (AC2 — default `approval`; promoted to `auto` only when a
   venture has *earned* it with external wins, within a pre-committed window cap, owner-workspace-first, and
   the content provenance is trusted); `applyQuarantine` (the #200 §6 latch — a web-read-tainted draft can
   never be `auto`); `decideRetry` (AC3 — transient social failures retry with backoff, then surface);
   `reversibilityForChannel` (the #200 §4 classes). All pure, exhaustively unit-tested.

2. **Compliance enforced in code (`compliance.ts`, AC2).** An email suppression list (bounce / complaint /
   unsubscribe) consulted on **every** send; a CAN-SPAM + GDPR footer (physical postal address + working
   unsubscribe + data-rights line) built and idempotently appended; a `checkEmailCompliance` gate that
   hard-fails a send with no footer, no address, or no deliverable recipient; and a **domain-warmup**
   schedule that caps a cold domain's daily volume so a blast can't torch deliverability (the §4
   pre-commitment bound for the most irreversible channel).

3. **Provider seams with dry-run defaults (`providers.ts`).** `AdsProvider` / `EspProvider` /
   `SocialProvider` / `SeoPublishProvider` each default to a **dry-run** (no network, deterministic receipt
   id, `dryRun:true`) — exactly the recorded-only posture of `billingRefund` and `DryRunDnsProvider`. Real
   Google/Meta/Postmark/X/LinkedIn adapters are a deliberate future step, lazily loaded behind connected
   credentials; the factory never reaches the network on the default path.

4. **The dispatcher slots into the one send chokepoint (`execution.ts`).** `makeExternalSend` (ADR-0013 §2 /
   ADR-0151) gains an **optional** `AcquisitionDispatcher`, consulted *after* the #151 egress check. It
   routes by kind → channel, runs the channel's in-code guards (envelope for ads; suppression + footer +
   warmup for email), calls the provider, and writes an external-grounded **send receipt**. It returns
   `null` — falling back to recorded-only — whenever the send is not an acquisition kind or the channel is
   not cleared to execute (flag off). With no dispatcher injected, the executor is unchanged.

5. **CAC + conversions into the brief (`cac.ts`, AC5).** Spend (from real ad-spend receipts) and conversions
   (from external receipts) roll into an **optional** acquisition section on the daily brief (#173). A CAC
   computed from self-reported conversions is labeled `UNVERIFIED` and never blended into the verified
   number (premortem #200 §2). The brief input field is optional, so the brief is unchanged when off.

6. **Bounce/complaint ingest + suppression management (`webhook.ts`, `routes/acquisition.ts`, AC2).** A
   signature-verified ESP webhook (`HMAC-SHA256` over the raw body, secret from the #192 vault) maps
   bounce/complaint/unsubscribe events onto suppressions; an identity-gated route reads the list and adds
   manual suppressions. Deliverability is the law, enforced in code.

Three additive, sibling-safe tables (`0189`): `acquisition_budget_envelopes` (the money decision),
`acquisition_send_receipts` (the external-grounded proof), `acquisition_suppressions` (the list). Named
`acquisition_*` (not a governed `growth_*`/`venture_*` table) so the #155 metric-surface colocation check is
not tripped.

## Consequences

- **Irreversible sends are bounded, not trusted.** Ad money never leaves an owner-approved envelope
  autonomously; an earned email auto-send is capped per window; a cold domain warms up; SEO (reversible) is
  the only channel that can go fully autonomous. Everything else defaults to a human #13 yes.
- **A poisoned read can't pull a lever.** `applyQuarantine` is a standalone latch, not a parameter — any
  `auto` gate computed from web-read provenance is forced back to `approval`, separating the web-reading
  agents from the spend/send agents (#200 §6).
- **The brief tells the truth.** CAC and conversions come from receipts; an unverified blend is labeled so,
  and never drives the number on its own (#200 §2). Daily spend receipts land in the owner's existing brief.
- **Zero blast radius by default.** Flag off → the dispatcher returns `null` and the executor is recorded-only,
  byte-for-byte; the brief omits the section; the routes' writes 409. One additive migration, no change to
  any existing business-domain table. Real sends additionally require an owner-connected provider.

## Alternatives considered

- **Send directly from a new agent harness tool.** Rejected: it would put "leave the building" back in an
  agent's hands. Every send stays a #13 `external.send`; execution is system infrastructure behind the
  approval, and the marketing agents keep their draft-only runbooks unchanged.
- **Enforce the budget envelope at policy/submission time instead of execution.** Rejected as the primary
  guard: the executor only sees the payload, and a cumulative cap must be checked against real spend at the
  moment money moves. The envelope is checked + debited in the dispatcher; the #13 `amount` gate still
  re-gates a single large spend at submission, so both bounds hold.
- **Add a `ComplianceEnforcer` like #196's send-layer enforcer.** Deferred: #196 (the legal pack) is not on
  this branch. Email compliance is enforced here in the dispatcher's email path; when #196 lands, its
  enforcer composes alongside the egress + acquisition seams in `makeExternalSend` without conflict.
- **Wire real Google/Meta/Postmark/X adapters now.** Rejected for this PR: a real outbound adapter is an
  irreversible autonomous call and belongs behind connected credentials + its own ADR. The dry-run default
  proves the whole control path (envelope, compliance, warmup, receipts, brief) with zero network risk.
