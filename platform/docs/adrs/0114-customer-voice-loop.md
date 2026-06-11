# ADR-0114: Customer Voice Loop — support, feedback ingestion, and churn signal after launch

- **Status:** Accepted (shipped in PR for #114)
- **Date:** 2026-06-11
- **Context issue:** [#114](https://github.com/gagan114662/agent-skills/issues/114)
- **Spec:** [docs/specs/114-customer-voice-loop.md](../specs/114-customer-voice-loop.md)
- **Builds on:** [ADR-0049](0049-venture-loop.md) (#96 — the pure `rubric.ts` 0–100 scorer + the
  scorecard overlay seam this voice signal feeds), [ADR-0101](0101-demand-validation-rails.md) (#101 —
  the demand overlay this composes with; the signed-webhook + IDOR-lookup pattern), [ADR-0050](0050-founder-console.md)
  (#104 — the read-only daily-review pane the voice view is added to), [ADR-0043](0043-revenue-rails.md)
  (#98 — the `revenue_evidence` kind-tagged evidence-row pattern + `verifyWebhookSignature`),
  [ADR-0013](0013-approval-gates.md) (the `external.send` gate every outbound reply rides),
  [ADR-0102](0102-growth-loop.md) (the two-table workspace-scoped durable shape + the config-block
  gotcha + the #107 "read is the seam" posture), [ADR-0035](0035-config-layering.md) (#58 — the layered
  config the `voice` block plugs into), [ADR-0099](0099-disaster-recovery.md) (the by-issue numbering
  convention).

> **Numbering note.** Spec / migration / ADR all use the `0114` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Context

Premortem (owner directive): **ventures launch and go deaf.** The platform can validate (#101), fund
(#96), deploy (#73), and charge real money (#98) — and then never hear a single user. No support inbox,
no feedback ingestion, no churn signal. "Talking to users" is the irreducible founder work, and it did
not exist at all.

The hard part is not storing a message. It is making the **voice of the customer** a first-class, typed,
tenant-scoped input to the decisions the platform already makes — while keeping the one irreducible
human gate: an agent must never autonomously send an outbound reply to a real customer (a bad auto-reply
is exactly the irreversible, outward-facing action #13 exists to pause).

## Decisions

1. **Two workspace-scoped durable tables + a pure core (the #101/#102 shape).** `support_tickets` is the
   inbound inbox (one row per inbound message, deduped on `(workspace_id, channel, source_ref)`);
   `voice_insights` is the structured-evidence log (one `user_voice` row per classified signal, deduped
   on `(workspace_id, source_kind, source_ref)`). Every query filters `workspace_id` (the #3 IDOR
   boundary); `venture_idea_id` / `ticket_id` / `created_by_member_id` are **soft refs** (SET NULL) so an
   insight outlives a pruned idea/member. Additive-only ⇒ no sibling-migration collision.

2. **The classifier is pure and deterministic (the `rubric.ts` analogue).** `voice/classify.ts` turns a
   feedback message into `{ sentiment, churnRisk, category, signals }`: an NPS score dominates when
   present (0–6 detractor → negative/high churn, 7–8 → neutral/medium, 9–10 → positive/low), a
   `cancellation` source biases negative/high, churn keywords raise churn-risk, and category is
   keyword-routed. `voice/metrics.ts` aggregates the insight rows into a sentiment/churn breakdown + an
   NPS score (−100…100, `null` with no responses). Both unit-tested in isolation; the IO `service.ts`
   only classifies-then-persists and reads.

3. **`user_voice` evidence extends the #98 kind-tagged pattern — in this feature's own tables.** Rather
   than write into billing's `revenue_evidence`, the insight rows ARE the evidence, tagged `kind =
   'user_voice'` with a `source_kind` discriminator. This keeps the #98 → #114 dependency one-way and the
   tenant scoping local, while following the same "evidence is a kind-tagged row a loop consumes" model.

4. **Feeds #96 via a composable overlay; #107 via a read.** `VentureService` gains an optional
   `voice?: VoiceEvidenceSource`. `score()` now composes overlays explicitly: `combineDimensions` →
   (demand overlay if present) → (voice overlay if present) → `scorecardMeanScore`. The voice overlay
   replaces only the **`problemSeverity`** dimension (post-launch customer voice is the most honest
   evidence the problem is actually acute, the way #101 demand replaces `willingnessToPay`). With neither
   source the score is **byte-for-byte** today's `aggregateScorecards`; with only demand it is
   byte-for-byte the existing #101 behaviour (`aggregateWithDemandOverlay` is retained for #101's own
   tests). The per-venture `userVoiceEvidence` read / `metrics` read IS the seam the **#107 portfolio
   loop** (no code yet) will roll up.

5. **Outbound replies stay #13-gated, sensitive-by-default.** `submitReply` builds the **existing**
   `external.send` descriptor (`buildVoiceReply`, the `buildMarketingSend` pattern) and enqueues a
   **pending** approval; the ticket moves to `awaiting_approval` and is linked to the request. A human
   approves every send in v1. No new approval action type, no change to `approvals/policy.ts` or the
   executor (`external.send` is recorded-only). The triage agent only ever **drafts** — and only when a
   deployment opts in (no triage agent is wired by default, so the safe default is "ticket lands open,
   needs a human").

6. **Surfaced read-only in #104.** The Founder Console gains a `voice` view (tickets needing a human, the
   sentiment/NPS roll-up, the weekly digest headline from the pure `buildVoiceDigest`) + an attention
   reason when tickets need a human. The reader uses the **same** pure aggregator the routes use, so the
   console and the API never disagree. No new mutation — strictly read-only.

7. **Default-OFF policy, safe-by-default ingest.** A `voice` config block (`enabled`, `digestWindowDays`,
   `autoTriageDraft`) joins the #58 layered config — registered in **both** `mergeSettings` and
   `mergeLayers` (and `schema.ts`'s settingsSchema / ResolvedConfig / CONFIG_DEFAULTS), the documented
   gotcha that a block missing from any of them silently drops at runtime. The inbound **webhook is
   secret-gated**: with no `voice` webhook secret configured the route returns `503` (default-OFF). Ingest
   itself is harmless and tenant-scoped; `enabled`/`autoTriageDraft` gate only the proactive draft posture.

## Consequences

- **Additive + default-OFF.** New tables, new routes, a new optional console field, a new config block, a
  new optional `VentureService` dep — a deployment that opts into nothing is unchanged. No background tick
  (voice is event-driven ingest + on-demand read; a scheduled weekly digest can be added later the #117
  way).
- **Inbound-only by construction.** The only outbound path is a #13-gated, recorded-only `external.send`;
  the integration test asserts a submitted reply is *pending*, never executed.
- **Tenant isolation.** Every route is `assertWorkspace`-guarded and every query `workspace_id`-scoped;
  the integration test proves cross-workspace access 404s and the webhook is `:wid`-scoped.
- **Deferred:** a real email/IMAP/provider-SDK inbound adapter (the signed webhook is the contract); an
  auto-reply #13 rule (v1 is human-approves-every-send); hot-wiring #107 (the per-venture read is the
  seam); a scheduled voice-digest tick.
