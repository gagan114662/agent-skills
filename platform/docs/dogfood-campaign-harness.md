# Dogfood campaign harness

A repeatable, end-to-end dogfood run against the **deployed** ipop.ai: submit one complex brief, require the
fleet to deliver a complete integrated campaign, score every asset against a D&AD/Cannes-style award bar, and
turn every shortfall into a filed gap. See [ADR-1586](adrs/1586-dogfood-campaign-rubric-and-harness.md) and
epic #1539.

## The three pieces

| Piece | Location | What it is |
| --- | --- | --- |
| **Brief** | `apps/server/src/campaign-rubric/brief-fixture.ts` (`IPOP_LAUNCH_BRIEF`) | The one complex brief — *ipop.ai launching itself*. Sharp ICP, one positioning line, a dry non-hype voice, approved brand claims. Same shape as the live `PUT /workspaces/:wid/campaign-brief` API. |
| **Rubric** | `apps/server/src/campaign-rubric/` | Pure, deterministic, objective-first scoring. Four numeric dimensions, per-channel spec validators, AI-slop + brand-claim checks, coverage, gap drafts. |
| **Harness** | `apps/server/scripts/dogfood-campaign-harness.ts` | Probes deployed api.ipop.ai, submits the brief, attempts fleet generation, scores the result, emits a scored artifact + gap report. Review-only. |

## The award bar

Four dimensions, each 0–10, weighted into a composite:

| Dimension | Weight | Judged by |
| --- | --- | --- |
| insight (idea originality) | 0.30 | Lens/human only — not machine-detectable |
| craft (execution) | 0.30 | objective floor (spec + slop), Lens may only **lower** it |
| channel-nativeness | 0.20 | objective (does it fit the channel's native form) |
| coherence (one voice, no invented claims) | 0.20 | objective (brand-claim allowlist + slop) |

An asset is **award-ready** only when it is Lens-graded **and** composite ≥ 8.0 **and** every dimension ≥ 7.0
**and** it has no spec error. Because insight needs a Lens grade, an **ungraded asset can never clear the
bar** — the harness reports it as blocked, never as passing.

### Required assets (a complete campaign)

`blog`, `landing-hero`, `google-search-ad`, `meta-ad`, `email` ×5, `social-x`, `social-linkedin`,
`social-instagram`, `social-tiktok`, `video-script`, `ooh-print`. Missing/short kinds are coverage gaps.

### Objective spec (the machine floor)

Real published channel limits (`spec.ts`): Google RSA 3–15 headlines ≤30 chars + 2–4 descriptions ≤90 chars;
Meta headline ≤40 + required visual concept; X ≤280; TikTok hook + beats; 30s video + shot list; OOH ≤7-word
line; long-form blog ≥700 words; hero headline + subhead + CTA. A spec **error** makes an asset spec-invalid
and caps craft, so no grader optimism can rescue it. AI-slop phrases and unapproved superlative/numeric claims
(#200 FM#2 — invented metrics) are flagged with concrete rewrite notes.

## Running it

```bash
cd platform/apps/server
# Score-only run against deployed ipop.ai (default target https://api.ipop.ai):
npx tsx scripts/dogfood-campaign-harness.ts

# With a human token, also submit the brief to a workspace:
IPOP_AUTH_TOKEN=<token> IPOP_WORKSPACE_ID=<wid> npx tsx scripts/dogfood-campaign-harness.ts

# Custom output dir:
DOGFOOD_OUT=/tmp/run npx tsx scripts/dogfood-campaign-harness.ts
```

Outputs (per run, under `DOGFOOD_OUT`): `scored-campaign.md`, `gap-report.md`, `run.json`.

**The harness never sends anything external** — no issues, no publishing, no spend. Filing gaps as GitHub
issues is a separate, human-gated step: review `gap-report.md`, dedupe against open issues, then
`gh issue create`.

## Run of 2026-07-02 (deployed ipop.ai)

| Probe | Result |
| --- | --- |
| `GET /readyz` | **OK** — `{"status":"ready","db":"up","redis":"up","loops":{"status":"ready"}}` |
| `GET /version` | **OK** — `{"version":"55e21a5b..."}` (deploy current, not stuck) |
| `PUT /campaign-brief` | **BLOCKED** — 401, human-auth by design (#1587) |
| Fleet generation | **BLOCKED** — agent spawning down on prod (#1536); no output faked |

Because fleet generation was blocked, the run scored the **labelled demonstration asset set** (hand-authored,
not fleet output) to exercise the rubric. It correctly caught the seeded flaws — a 47-char RSA headline
(spec-invalid), an AI-slop "seamlessly", and an unapproved "10x" claim — and correctly reported every asset as
ungraded/below-bar. The run also surfaced and fixed a real false-positive bug (substring "any" matching
"company"). Verdict: **below-bar**, blockers named.

### What was filed vs deduped (honesty)

- **Filed:** #1586 (this rubric + harness capability), #1587 (harness can't seed the brief unattended).
- **Deduped, not re-filed:** the agent-spawn blocker → tracked by #1536; the grader is part of epic #1539.
- **Not filed:** the three asset defects — they are flaws *deliberately seeded into the fixtures* to prove the
  rubric bites, not product gaps.

When agent spawning returns, point the harness at real fleet output and the same rubric grades it — the
demonstration set is only a stand-in while generation is blocked.
