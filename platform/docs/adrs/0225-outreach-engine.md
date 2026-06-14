# ADR-0225: Outreach engine — signal-triggered, owner-gated, externally measured

- **Status:** Accepted (shipped in PR for #225)
- **Date:** 2026-06-14
- **Context issue:** [#225](https://github.com/gagan114662/agent-skills/issues/225)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — an outbound send is
  IRREVERSIBLE (deliverability + brand: a sent message cannot be unsent). Every send is therefore
  **pre-committed, never post-hoc**: the engine only ever PARKS a `outreach.send` #13 request (exact
  recipient + content on the card), and the byte-push happens solely through the post-approval executor.
  There is NO autonomous-send code path. Per-channel rate caps + (future) suppression/opt-out protect
  deliverability. Metrics come from EXTERNAL receipts only — projections are labeled `UNVERIFIED` and
  never drive a decision alone.
- **Quarantine:** [#223](https://github.com/gagan114662/agent-skills/issues/223) — the engine consumes
  the buyer brief as already-sanitized DATA; it holds NO live profile reader. The message RECIPIENT is
  derived ONLY from structured identity (`<channel>:<buyerContactId>`), never from read text, and
  composition is a pure DATA→DATA function. So a poisoned enrichment read can, at most, place a sanitized
  string on an owner-reviewed approval card — it can never change who is contacted or trigger a send.
- **Builds on:** [ADR-0222](0222-customer-discovery-engine.md) (the ranked PQL queue + 5-stage GTM
  pipeline this consumes and advances), [ADR-0223](0223-decision-maker-resolver.md) (the
  injection-quarantined buyer brief this leads with), [ADR-0231](0231-real-world-tool-surface.md) (the
  gated tool surface — `decideToolGate` decides channel availability + what to connect; `send_email`
  needs esp+registrar, `post_social` needs an ad account), [ADR-0013](0013-approval-gates.md) (the one
  approval queue; the new `outreach.send` action is sensitive-by-default AND irreversible and never
  weakens it), [ADR-0099](0099-disaster-recovery.md) (by-issue migration/ADR numbering).

> **Numbering note.** Migration (`0225_outreach_engine.sql`) and ADR both use the `0225` slot (the issue
> number), per the by-issue numbering convention. The `outreach_messages` / `outreach_receipts` tables
> are deliberately NOT `venture_`/`growth_`-prefixed so the #155 colocation gate does not class them as
> governed metric surfaces.

## Context

The Wispr "money machine": compose the message that works for a persona, pick the channel that works,
and trigger it the moment a product-qualified signal fires — "solve their problem, don't sell the
product" — then iterate value-prop angles (time saved / productivity / cost) and keep only what
converts. #222 produced the ranked PQL queue and #223 the buyer brief, but nothing yet turned a signal
into an outbound conversation. The hard constraints: a send is irreversible (deliverability/brand), and
the #223 injection-quarantine boundary must survive end-to-end (a poisoned enrichment read can never
cause or alter a send).

## Decision

1. **Pure core (`outreach/compose.ts`).** `composeMessage` leads with the prospect's problem (a topic
   they care about → the account pain area → a role-generic fallback), frames the value-prop variant, and
   closes with a channel-fitting CTA. The recipient is structural; read-derived `evidence` is kept OUT of
   the body (it rides along only as approval-card grounding). `channelPreference`/`selectChannel`
   auto-select the channel per PQL signal (role signal → LinkedIn; intent → email), intersected with
   connected channels. `selectVariant` assigns a value-prop variant deterministically (FNV-1a, no RNG).
   `concludeExperiment` decides a winner ONLY from external receipts (a strict lead; ties stay running);
   the per-variant conversion rate is a projection, labeled `UNVERIFIED`.

2. **Service (`outreach/service.ts`).** Consumes the #222 queue + #223 brief (read-only seams), composes,
   and `queue()`s by PARKING a `outreach.send` #13 request — it has NO send/provider seam, so no
   autonomous send is even expressible. `recordReceipt()` accepts EXTERNAL receipts only (non-empty
   `external_ref`), is idempotent, and advances the #222 pipeline into the conversion step through a
   NARROW advancer that can do nothing but record an externally-grounded conversion. `experiments()` /
   `summary()` compute results from real messages + receipts and feed the founder console.

3. **Gate + executor.** `outreach.send` is added to both `DEFAULT_SENSITIVE_ACTIONS` and
   `IRREVERSIBLE_ACTIONS`. The registry executor is recorded-only: on owner approval it flips the parked
   message to `sent` (recording the owner's go) and makes NO network call. A real ESP/social adapter
   behind this gate is a deliberate future ADR — outreach is never autonomous.

4. **Wiring + surface.** New `outreach_messages` / `outreach_receipts` tables (migration 0225), read-only
   routes (`draft` / `experiments` / `messages`) plus a `queue` POST that only parks an approval and a
   `receipts` POST for inbound proof. A founder-console outreach pane surfaces experiments running +
   external reply/meeting/signup counts + the gated send queue. Config `outreach.{enabled,sendProvider,
   perChannelDailyCap}`, default OFF (recorded-only `dryrun` sender) across schema/layers/loader.

## Consequences

- A PQL + brief yields a drafted, channel-appropriate, personalized message QUEUED for one-tap approval —
  never auto-sent. Tests prove an autonomous send is blocked and that injected enrichment cannot trigger
  a send or change the recipient (unit + real-Postgres integration).
- The owner sees, on one card, exactly who would be contacted and the full content before anything leaves.
- Experiment winners and the GTM funnel move only on external receipts; the company never fools itself
  with projected wins.
- Default OFF + recorded-only sender means CI/tests never make outbound calls; turning on a real channel
  is a future, deliberate step behind the #192 vault + a new ADR.
