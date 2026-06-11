---
name: lens-knowledge
agent: lens
kind: knowledge
version: 1.0.0
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

made by robots, steered by humans.
