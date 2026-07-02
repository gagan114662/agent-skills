# ADR-1586: Objective-first award rubric + repeatable dogfood campaign harness

- **Status:** Accepted (dogfood / P1 — #1586)
- **Date:** 2026-07-02
- **Context task:** GitHub issue #1586, under epic #1539 (award-winning content engine) and complementing
  #1536 (team run produces zero drafts — Quill never executes, Lens reviews an empty workspace). The dogfood
  mission: use ipop itself to run the most complex marketing campaign it can, score every asset against a
  D&AD/Cannes-style award bar, and turn every shortfall into a filed gap with evidence.
- **Builds on:** ADR-0200 (premortem rails — §2 self-reported metrics are fiction, only receipts count; §4
  irreversible/money stays human-gated; §6 external/agent content is untrusted DATA). Reuses the existing
  `campaign-brief` single-source brief (#588) and the `dogfood-evaluator` failure→issue dedupe flow (#1196).

## Context

The repo could *ask* the fleet to make marketing assets but had no way to *judge* them. `dogfood-evaluator`
classifies process failures (no deliverable, no receipt, placeholder text) into GitHub issues, and
`campaign-brief` gives every agent one ICP/positioning/voice source of truth — but nothing scored an asset's
craft, checked that a Google RSA headline fits its 30-character limit, caught AI-slop or an invented metric,
or verified a 5-email nurture sequence was actually five emails in one voice. There was also no repeatable
harness to drive a run against the deployed API and emit a scored artifact + gap report.

Two hard constraints shaped the design:

1. **The Lens grader is an agent, and agent spawning is currently down on prod.** A rubric that *requires* a
   live grader would produce nothing today. So the score must stand on objective, machine-checkable signals,
   with the subjective grade as an optional overlay.
2. **Honesty (ADR-0200 §2).** The harness must never present demonstration inputs as fleet output, and must
   never fake a passing grade. An ungraded asset is reported as blocked, not as award-ready.

## Decision

Add a pure, deterministic, **objective-first** rubric module (`apps/server/src/campaign-rubric/`) and a
repeatable harness script (`apps/server/scripts/dogfood-campaign-harness.ts`).

- **Four numeric dimensions**, weighted into a 0–10 composite: insight (0.30), craft (0.30),
  channel-nativeness (0.20), coherence (0.20). **Award bar:** graded by Lens/human AND composite ≥ 8.0 AND
  every dimension ≥ 7.0 AND no spec error. An ungraded asset can never clear the bar — the honest state while
  the grader is down.
- **Objective spec validators** (`spec.ts`) for every mandated asset type, using real published channel
  limits: Google RSA (3–15 headlines ≤30, 2–4 descriptions ≤90), Meta (headline ≤40, visual concept
  required), email (subject/preheader/body/CTA), social (X ≤280, LinkedIn hook, IG hashtags, TikTok hook +
  beats), 30s video + shot list, OOH glanceability (≤7 words), long-form blog, landing hero. A spec `error`
  makes an asset spec-INVALID.
- **Voice & truth checks** (`voice.ts`): an AI-slop lexicon (detects "generic") and a brand-claim allowlist
  check (ADR-0200 §2 — a superlative or numeric claim not on the brief's approved list is flagged as an
  invented metric). Matching is token-bounded, not raw substring — a real run caught the naive bug where
  "any" matched inside "company".
- **Craft is a hard CAP** (`rubric.ts`): a supplied craft grade is `min(grade, objectiveCraft)`, so a grader
  can never wave through a spec-invalid or slop-ridden asset.
- **`scoreCampaign`** returns coverage gaps (missing/short asset kinds), per-asset scores, the below-bar set
  to iterate on, named blockers, and a verdict (`award-ready` / `below-bar` / `incomplete`). `deriveGapDrafts`
  turns that into dedup'd, fingerprinted issue drafts — and deliberately does NOT emit a per-asset issue for
  assets that are below-bar *only* because they are ungraded (that is one root cause, filed once).
- **The harness** probes deployed `api.ipop.ai` (`/readyz`, `/version`), submits the brief when a human token
  is supplied (else records BLOCKED), records fleet generation as BLOCKED while spawning is down (it does not
  fake output), scores the assets it has, and writes `scored-campaign.md` + `gap-report.md` + `run.json`. It
  is REVIEW-ONLY: it creates no issues, sends nothing, spends nothing. Filing gaps is a separate human-gated
  step.

## Consequences

- The fleet finally has a numeric grading contract Lens can apply, with concrete rewrite notes — the missing
  half of epic #1539. The rubric is unit-tested and deterministic, so the bar can't silently drift.
- A dogfood run produces a real, defensible score today, and cleanly upgrades to grading *real* fleet output
  once agent spawning returns (#1536) and a Lens grade is wired (#1586 acceptance).
- The harness cannot yet seed the brief unattended (#1587) — documented, not hidden.
- The demonstration asset set is labelled as hand-authored; its seeded flaws are proof the rubric bites, not
  product gaps, and are intentionally NOT filed as issues.
