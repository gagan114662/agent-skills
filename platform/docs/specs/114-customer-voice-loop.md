# Spec — Customer Voice Loop (#114)

> **Numbering note.** Spec / migration / ADR all use the `0114` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Problem

Premortem (owner directive): **ventures launch and go deaf.** A venture that the platform validated
(#101 demand), funded (#96), deployed (#73), and charged real money for (#98) has no way to *hear its
users* afterward. There is no support inbox, no feedback ingestion, no churn signal. "Talking to users"
is the irreducible founder work — and today it does not exist at all.

The hard part is not "store a message". It is making the **voice of the customer** a first-class,
typed, tenant-scoped input to the decisions the platform already makes (the venture scorecard #96, the
Founder Console #104, the portfolio loop #107) — while keeping the one irreducible human gate: **an
agent never sends an outbound reply autonomously.** A bad auto-reply to a real, frustrated customer is
exactly the kind of irreversible, outward-facing action that must pause for a human.

## Goals

1. **Per-venture support inbox (inbound only).** A signed inbound webhook (an email/support provider's
   forwarding hook) turns a customer message into a workspace-scoped `support_ticket`. A triage step
   classifies it (sentiment / churn-risk / category) and may **draft** a reply — but the draft is never
   sent. Tenant-isolated (`workspace_id`, the #3 IDOR boundary).
2. **A pure classifier.** Deterministic sentiment / churn-risk / category / NPS extraction over a
   feedback message — unit-tested in isolation, the #96 `rubric.ts` pattern. The classifier turns every
   inbound voice signal (support ticket, checkout abandon, cancellation reason, NPS response) into a
   structured `voice_insight` row. These insight rows are the **`user_voice` evidence** the platform
   reasons over — extending the #98 `revenue_evidence` "kind-tagged evidence row" pattern.
3. **Outbound replies stay #13-gated, sensitive-by-default.** Submitting a reply builds the existing
   `external.send` descriptor (the `buildMarketingSend` pattern → `buildVoiceReply`) and enqueues it as a
   **pending** #13 approval. A human approves every send in v1. No new approval action type, no change to
   `approvals/policy.ts` or the executor (the send is recorded-only).
4. **Churn / NPS signal feeds the scorecard + console + portfolio.** A pure metrics aggregator computes
   sentiment breakdown, churn-risk distribution, and an NPS score (−100…100) from the insight rows. The
   per-idea insight rows are the seam the **venture scorecard (#96)** consumes (a 0–10 voice signal
   overlaid onto the `problemSeverity` dimension), and a workspace-scoped read the **portfolio loop
   (#107)** can roll up.
5. **Founder Console (#104) surfaces.** A read-only voice pane: tickets needing a human (the inbox that
   demands attention), the sentiment / NPS roll-up, and a weekly voice-of-customer **digest** drafted by
   the pure digest builder. An attention reason fires when tickets need a human.

## Non-goals (deferred)

- **A real email/IMAP poller or provider SDK.** The inbound contract is a signed webhook (the #98
  pattern); wiring a specific provider's inbound-parse format is a thin adapter over the same route.
- **Autonomous outbound replies.** v1 is human-approves-every-send by construction. Auto-reply policy
  (a per-workspace rule that auto-approves low-risk replies) is a future #13 rule, not this PR.
- **Re-wiring `VentureService.score()` is included** (the voice overlay), but the **portfolio loop
  (#107)** consuming the per-venture metrics read is left as the documented seam (no #107 module exists
  yet) — matching how #102 left its `#107` consumer as a seam.
- **A scheduled voice tick.** Voice is event-driven ingest + read; the weekly digest is a Founder
  Console read on demand.

## Design

### Data model (migration `0114_customer_voice_loop.sql`)

Two workspace-scoped tables (the #101/#102 two-table shape):

- **`support_tickets`** — the inbound support inbox. `(id, workspace_id→cascade, venture_idea_id` soft
  ref SET NULL`, channel` (how it arrived: `email` / `webhook` / `widget`)`, source_ref` (the external
  message id — the dedupe key)`, contact` (who wrote in)`, subject, body, sentiment` (nullable until
  classified)`, churn_risk` (nullable)`, category` (nullable)`, status` (`open` → `triaged` →
  `awaiting_approval` → `replied` → `closed`, default `open`)`, draft_reply` (the agent's drafted reply,
  never sent)`, reply_approval_request_id` (soft ref to the #13 request once a reply is submitted)`,
  triage_session_id` (soft ref to the #59 triage session)`, created_by_member_id` SET NULL`,
  created_at, updated_at)`. `UNIQUE(workspace_id, channel, source_ref)` makes inbound idempotent.
- **`voice_insights`** — the structured `user_voice` evidence rows. `(id, workspace_id→cascade,
  venture_idea_id` soft ref SET NULL`, ticket_id` soft ref SET NULL — provenance back to the ticket`,
  kind` default `'user_voice'` (the evidence class, mirroring #98 `revenue_evidence.kind`)`,
  source_kind` CHECK ∈ `support_ticket` / `checkout_abandon` / `cancellation` / `nps``, sentiment`
  CHECK ∈ `positive`/`neutral`/`negative``, churn_risk` CHECK ∈ `low`/`medium`/`high``, category` text`,
  nps_score` int 0–10 nullable`, summary` text`, source_ref` text nullable`, created_at)`.
  `UNIQUE(workspace_id, source_kind, source_ref)` dedupes a replayed feedback signal. Indexes on
  `(workspace_id)` and `(venture_idea_id)`.

Additive-only ⇒ no sibling-migration collision. Every query filters `workspace_id`; idea/ticket/member
links are soft (SET NULL) so an insight outlives a pruned idea.

### Pure core (`src/voice/`)

- **`classify.ts`** — `classifyFeedback(input)` → `{ sentiment, churnRisk, category, signals[] }`.
  Deterministic lexicon + rules: an NPS score dominates when present (0–6 detractor → negative/high,
  7–8 passive → neutral/medium, 9–10 promoter → positive/low); a `cancellation` source biases
  negative/high; churn keywords (`cancel`, `refund`, `too expensive`, `switching`, `broken`) raise
  churn-risk; positive/negative word sets set sentiment; category is keyword-routed (`bug` / `pricing` /
  `feature_request` / `praise` / `churn` / `support`).
- **`metrics.ts`** — `aggregateVoiceMetrics(insights)` → totals, sentiment breakdown, churn-risk
  distribution, and NPS (`promoters`, `passives`, `detractors`, `score` = %promoters − %detractors,
  −100…100, `null` when there are no NPS responses), plus `byCategory`.
- **`scorecard-evidence.ts`** — the #96 ↔ #114 seam. `VOICE_DIMENSION = "problemSeverity"`;
  `voiceDimensionScore(evidence[])` → 0–10 (start neutral 5, promoters/positive push up, detractors/
  high-churn pull down; empty handled by the caller as "no overlay"); `overlayVoiceDimension(combined,
  score)` replaces only the `problemSeverity` dimension. Real post-launch customer voice is the most
  honest evidence of whether the problem is actually acute — so it overlays `problemSeverity`, the way
  #101 demand overlays `willingnessToPay`.
- **`digest.ts`** — `buildVoiceDigest(input)` → the weekly voice-of-customer digest (headline, the
  metrics roll-up, top themes by category, and the count of tickets needing a human). Pure ⇒
  unit-tested (acceptance).
- **`reply.ts`** — `buildVoiceReply(input)` → the `external.send` descriptor (`kind: "support.reply"`),
  sensitive-by-default. Mirrors `buildMarketingSend`; changes neither the policy nor the executor.
- **`caps.ts`** — `resolveVoiceCaps(cfg)` → `{ enabled, digestWindowDays, autoTriageDraft }`,
  **default OFF** (mirrors `growth/caps.ts`).

### IO orchestrator (`src/voice/service.ts`) + wiring (`default.ts`)

`CustomerVoiceService` — side effects behind injected seams (`TicketStore`, `InsightStore`, `ReplyGate`,
optional `TriageAgent`, `VentureLookup` for the #19 IDOR boundary, `killSwitch`, `webhookSecret`, `now`,
`caps`). Methods: `ingestTicket` (dedupe → classify → persist ticket + insight → optionally draft via the
triage agent when `caps.enabled`), `ingestFeedback` (abandon / cancellation / NPS → classify → insight),
`submitReply` (build the descriptor → enqueue a **pending** #13 request → set the ticket
`awaiting_approval`; **never sends**), `metrics`, `digest`, `needingHuman`, and `userVoiceEvidence` (the
#96 source). `default.ts` wires the db repos, a `ReplyGate` that creates a pending `external.send`
request, the webhook secret (config/secrets), and **no triage agent by default** (so the safe default is
"ticket lands open, needs a human" — drafting only when a deployment opts in).

### Routes (`src/routes/voice.ts`)

- `POST /voice/webhook/:wid` — signed (HMAC, reusing the #98 `verifyWebhookSignature`), parsed in an
  encapsulated buffer scope. `kind: support` → `ingestTicket`; `checkout_abandon` / `cancellation` /
  `nps` → `ingestFeedback`. No webhook secret configured ⇒ `503` (default-OFF). Bad signature ⇒ `400`.
- `GET /workspaces/:wid/voice/tickets` (`?needsHuman=1`), `GET …/voice/tickets/:tid`,
  `POST …/voice/tickets/:tid/reply` (→ `submitReply`), `GET …/voice/metrics`, `GET …/voice/digest` —
  each `requireIdentity` + `assertWorkspace` (the #3 tenant boundary on every route).

### Founder Console (`#104`) + Venture scorecard (`#96`)

- Console: an optional `VoiceReader` seam (`needingHuman`, `digest`) → a `voice` pane (tickets needing a
  human, sentiment/NPS roll-up, digest headline) + an attention reason when tickets need a human. Zeroed
  when unwired (the moat/growth optional-pane convention).
- Scorecard: `VentureService` gains an optional `voice?: VoiceEvidenceSource`. `score()` composes the
  overlays — `combineDimensions` → demand overlay (if present) → voice overlay (if present) →
  `scorecardMeanScore`. With neither source it is **byte-for-byte** today's score (default-OFF); with
  only demand it is byte-for-byte the existing #101 behavior.

## Acceptance

- Integration (real Postgres + Redis, fakes for the agent/gate): signed webhook → `support_ticket` →
  classified `voice_insight` (`kind = user_voice`) evidence row — proven end-to-end.
- The reply-send gate is **sensitive-by-default**: `submitReply` enqueues a *pending* `external.send`
  request and the ticket moves to `awaiting_approval`; nothing is sent.
- The digest builder is unit-tested.
- Tenant isolation on every route (cross-workspace access ⇒ 404, no leak; the webhook is `:wid`-scoped).
- TDD failing-first; spec + ADR; one PR. Video gate waived by owner.
