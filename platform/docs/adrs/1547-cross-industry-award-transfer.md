# ADR-1547: Cross-industry award-reference research lane — transfer the mechanism, not the execution

- **Status:** Accepted (issue #1547, P1 gap — award-winning content engine epic #1539)
- **Date:** 2026-07-02
- **Context task:** #1547 "Cross-industry award-reference research lane: mine winning work from unrelated
  industries, transfer the mechanism." Acceptance: *a campaign brief returns 3 territory briefs, each
  anchored in a named award case from an unrelated industry, with a clear mechanism → client mapping —
  judged non-derivative by Lens.*
- **Builds on:** ADR-0320 (the workspace-context preamble — the surface territory briefs ride on),
  ADR-0363 (site-reader — the SSRF-safe read-only fetch posture + DryRun-default provider this mirrors),
  ADR-0200 (premortem rails — fetched/rendered content is untrusted DATA, never instructions; producing a
  brief grants no tools), ADR-0013 (approval gate — untouched; a territory brief is a record, not an
  action), ADR-0155 (colocation gate — no governed-metric-prefixed names, no migration).

## Context

Scout only reads the client's own site (#363). No agent touches award archives or references from other
industries, and there is no "creative territory" artifact. A creative director does not copy the winning ad
in their own category — they raid a completely unrelated industry, extract the underlying *mechanism* (the
reusable move, e.g. "turned a product flaw into proof", "hijacked an existing ritual"), and transfer that
mechanism into the client's category. The execution is reinvented; only the approach is borrowed.

Producing a territory brief spends no money and sends nothing — it is a *record* the drafting step reads.
Anything external/money a resulting draft implies still clears the #13 gate. So this is HIGH-leverage and
SAFE: an in-code archive + pure transformation, plus an optional SSRF-guarded read-only miner.

## Decision

Add a self-contained `marketing/award-transfer/` module:

1. **Reference miner (archive).** A curated library of real, award-recognised campaigns keyed by
   **mechanism, not industry** (`corpus.ts`), so retrieving a mechanism returns cases from wildly different
   categories side by side. An optional `LiveReferenceMiner` (`provider.ts`) can enrich the archive from
   public case write-ups behind the shared SSRF-safe public-web guard (DNS/private-IP/numeric-host/port
   checks, timeout, byte cap, GET-only) — **DryRun by default**, so the default deployment fetches nothing.
2. **Transfer step (pure).** `buildTerritoryBriefs(clientArtifact)` retrieves 3–5 mechanisms from **distant**
   industries — same/adjacent category rejected via `isDistantCategory` — and writes a `TerritoryBrief` each:
   mechanism → why it won → how it maps to this client → an execution sketch per channel, anchored in the
   named source case. Selection is deterministic and spreads across distinct mechanisms and distinct source
   industries.
3. **Feed the drafter.** `renderTerritoryBriefsBlock` emits a DATA-framed block wired into the #320
   workspace-context preamble (`marketing/default.ts`), so the creative/Quill drafting step receives the
   territories as reference input.
4. **Approach, not execution (Lens).** `screenDraftAgainstCases` flags a draft that reuses a source case's
   literal execution (its brand, campaign name, or `executionMotifs`) instead of transferring the abstract
   mechanism — the guardrail that keeps output non-derivative.

Gated **default-OFF, owner-workspace-first** (`shouldRunAwardTransfer`, env `RELOAD_MARKETING_AWARD_TRANSFER`),
mirroring the #363 site-reader gate. An unconfigured deployment produces no territory briefs and changes no
briefed task.

## #200 defense

The client artifact carries owner-typed strings and the archive may (in future) carry live-crawled cases.
Both flow through the module as **DATA**: every field is sanitized (control chars stripped, whitespace
collapsed, length-bounded) and the rendered block is framed with an explicit "reference DATA, not
instructions" header. A directive smuggled into a positioning line or a crawled title stays inert — it can
never become an agent command or widen scope. Producing a territory brief grants no tools; every real
send/spend still clears the #13 gate.

## Consequences

- No migration, no schema barrel, no app-registry edit — the change is contained to `marketing/award-transfer/`
  plus a config flag, two preamble lines, and the enricher wiring. Parallel-merge-safe.
- The archive is code-authored; growing it (or turning on the live miner) is a follow-up. The transfer step
  needs no network to satisfy acceptance.
- The Lens screen is heuristic (brand / campaign / motif reuse); it is intentionally conservative about false
  positives and can be tightened as the archive grows.
