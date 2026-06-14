---
name: lens-knowledge
agent: lens
kind: knowledge
version: 1.2.0
description: Analytics domain knowledge router for @lens. Loaded on demand; points at curated reference files, never raw data.
---

# Analytics knowledge — @lens

A **thin router**, not an encyclopedia. When a task needs analytics depth, open the one
reference below that fits and read only that. Curated references are governed prose — they sit one rung
**above raw data** on the provenance ladder. Consult the governed sources **before raw** exploration.

## Domain
the analytics authority: every workspace metric question routes through the governed semantic layer.

## Curated references (load on demand)
- `references/analytics/metric-catalog.md` — open only when the task needs it.
- `references/analytics/provenance-ladder.md` — open only when the task needs it.
- `references/analytics/raw-fallback-protocol.md` — open only when the task needs it.

## Metric questions are not answered here
Numbers come from the **semantic layer** (@lens owns it), never from a number you eyeball in a dashboard.
If a task asks "what's our X?", route it through the semantic-layer metric catalog so the whole team quotes
the **same number**. A raw figure is a **fallback** — **flag** it as such, with its **provenance** and
**freshness**, and say it is unverified.

## Venture memory & planning surfaces (#197)
Three new venture-scoped surfaces carry the same **verified-vs-unverified** discipline — treat them on the
provenance ladder exactly like any other metric:
- **OKR drift** (`venture_okrs`) — a key result is `on_track` **only** when it has an externally-verified
  (#106) source. A self-reported number is **never** on-track; it reads `unverified` and flags the OKR as
  drifting. Quote a KR's status with its `source`, never the bare number.
- **Weekly-plan go/no-go** (`venture_plans`) — "go" requires at least one externally-verified (#106) metric
  receipt for the venture; the self-reported #96 scorecard score is context only and never flips it alone.
  Every drafted estimate is labelled `UNVERIFIED`. Every go/no-go cites the #200 premortem.
- **Cross-venture playbooks** (`venture_playbooks`) — a reusable pattern is only distilled from a
  **verified** win and carries provenance (an anonymized source-venture hash + the #106 receipt). Cite the
  provenance; a pattern without a receipt is not a pattern.

The throughline: self-reported is fiction (#200 mode 2). When you report any venture-memory number, route it
through the same one-number rule and flag anything not backed by an external receipt as **unverified**.

## Venture Factory surfaces (#187)
The factory that starts new ventures (`factory_candidates`, `factory_validations`, `factory_ventures`)
introduces three metric surfaces — hold them on the provenance ladder exactly like any other number:
- **Candidate opportunity score** (`factory_candidates.score`) — a 0–100 **multiplicative** estimate
  (source authority × freshness × pain × competition absence). It ranks *attention*, never *launch*: it is
  an internal estimate, so report it as **unverified** and never let it stand in for demand. A venture does
  not launch on a score; it launches on a qualified **edge** (below) and external receipts.
- **Validation scorecard** (`factory_validations`) — signups, spend, and CAC come from EXTERNAL receipts
  ONLY (signed webhooks, ad-spend records). The derived **CAC** and **score** are labelled `UNVERIFIED` and
  never kill/scale a venture alone (#200 mode 2). Quote the external signup count as the real signal; quote
  CAC/score as derived estimates with that label.
- **Edge status** (`factory_candidates.edge_status`) — the FM#1 gate: `qualified` means a *falsifiable*
  distribution/data/relationship edge backed by an external receipt or owner-attested secret; `rejected`
  means no edge. When you report a venture, lead with its edge status — a venture without a qualified edge
  is a flag, not a metric.

The throughline holds: an internal score is context, an external receipt is truth, and a venture with no
falsifiable edge never launches.

made by robots, steered by humans.
