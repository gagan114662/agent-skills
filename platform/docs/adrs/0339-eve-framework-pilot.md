# ADR-0339: eve-framework pilot — scaffold @bid on Vercel's eve, measure vs the bespoke scaffold

- **Status:** Accepted (spike; shipped in PR for #339). Recommendation: **conditional go** — adopt the
  eve *conventions* now, defer a fleet *runtime* migration behind one explicit gate (see Decision).
- **Date:** 2026-06-18
- **Context issue:** [#339](https://github.com/gagan114662/agent-skills/issues/339) — "eve pilot: scaffold
  one department agent on the eve framework, measure vs current scaffold."
- **Builds on:** [ADR-0200](0200-premortem-panel.md) (the premortem — FM#2 *self-reported metrics are
  fiction*, FM#3 *verification must touch reality*, FM#4 *reversibility classes*, FM#6 *injection defense*),
  [ADR-0123](0123-marketing-department-fleet.md) (the pure blueprint + drafts-only persona tool ceiling),
  [ADR-0155](0155-fleet-skills-semantic-layer-evals.md) (versioned in-repo skills), [ADR-0243](0243-money-only-approval.md)
  (money-only #13 gate), and the "managed fleet model, no user picker" change.

## Context

eve (`eve@0.11.5`, published by Vercel / rauchg) is an open-source "filesystem-first framework for durable
backend AI agents." Its model is strikingly close to ours: an agent is a directory — `agent/instructions.md`
(always-on charter), `agent/agent.ts` (`defineAgent({ model })`), `agent/tools/*.ts` (one typed tool per
file), `agent/skills/*` (on-demand `SKILL.md` procedures), `agent/channels/*` (HTTP/Slack). It ships
durable sessions (Vercel Workflow), a native human-in-the-loop approval gate, an Agent Runs observability
dashboard, and a one-command deploy to a public preview URL.

Our fleet is *already* markdown-skill + TS-tools (#123/#155), so the shape matches. #339 asks: scaffold ONE
department agent (@bid) on eve as a **parallel pilot**, map the existing skill markdown to the eve charter
and the TS tools to eve tool defs, **measure** LOC + setup time against the bespoke scaffold, and decide
go/no-go on a fleet migration — honoring #200 (real measured receipts, no irreversible action, injection
defense unchanged).

## What was built

`platform/pilots/eve-bid/` — @bid on eve, **isolated**: outside the pnpm workspace (`apps/*` + `packages/*`
globs exclude `pilots/*`), eslint-ignored, no live provider, no deploy. Nothing in production changes.

| ipop bespoke | eve equivalent | pilot file |
| --- | --- | --- |
| `blueprint.ts` `dept("ads", …)` `prompt()` system prompt | always-on charter | `agent/instructions.md` |
| `model: null` → managed `claude-opus-4-8` | AI Gateway model id `anthropic/claude-opus-4.8` | `agent/agent.ts` |
| `agents/skills/bid/knowledge.md` + `runbook.md` | on-demand skills (Agent Skills standard) | `agent/skills/*` |
| `DRAFT_TOOLS` built-in allowlist | eve default harness (`read_file`, `bash`, web) | framework-provided |
| the *draft* @bid produces | typed tool def (Zod schema) | `agent/tools/propose_ads_plan.ts` |
| #13 approval gate for the `ads` external-send dept | `needsApproval: always()` (native, durable) | `agent/tools/record_ad_spend.ts` |
| `subagents/scope.ts` env wiring + #68 runtime + seeder | eve session runtime + HTTP channel | framework-provided |

A behavior-parity unit test (`apps/server/test/unit/eve-bid-pilot-parity.test.ts`, 9 cases) asserts the port
preserves @bid's behavior against the **live** bespoke source of truth (`marketing/blueprint.ts` +
`agents/skills/bid/*`): identity/domain, the draft-then-gate / never-spend invariant in the charter, that
every money/send tool is gated `needsApproval: always()` *before* it runs, that the draft tool never spends,
governed-source discipline (semantic-layer-first, fallback-flag, provenance/freshness, one-number rule), and
the managed-model rule (no user picker).

## Measured receipts (real, not estimates — #200 §2)

| Metric | Bespoke @bid | eve @bid | Source / receipt |
| --- | --- | --- | --- |
| Scaffold + dep install time | n/a (in-repo, no scaffold step) | **184.72s real** (exit 0) | `/usr/bin/time -p npx eve@latest init` |
| Blank-agent authored LOC | n/a | 23 (`agent.ts`+`instructions.md`+`channels/eve.ts`) | `wc -l` on `eve init` output |
| Per-agent authored LOC | **≈110** | **204** (`agent/` surface) | `wc -l`: skills 73 + blueprint entry ~10 + manifest 27; pilot `agent/` 204 |
| — of which: skills | 73 | 67 | `wc -l` (near-identical; ports as-is) |
| — of which: tool defs | 0 (allowlist string) | 76 (two typed tools incl. the gate) | `wc -l` |
| Shared in-house runtime you maintain | **≥482** (`scope.ts` 148 + `blueprint.ts` 334), plus the #68 harness/manager/seeder | **0** (framework dependency) | `wc -l` |
| Durable sessions / HITL gate / observability / preview URL | build + maintain ourselves | included | eve docs (`concepts`, `human-in-the-loop`, `deployment`) |

**Reading of the numbers.** Per-agent authoring is *comparable* (eve ~2× the lines, because typed Zod tool
defs and an *explicit* approval gate are more code than an allowlist string + an implicit "no spend tool"
convention). The real delta is **shared infrastructure**: the ≥482-line bespoke scaffold/wiring surface
(plus the #68 runtime, seeder, @mention router, eval gate) becomes a maintained dependency under eve. The
extra per-agent LOC *buys* machine-checkable typed tools and a durable, native, pre-execution approval gate.

## #200 honored

- **§2 real receipts, not estimates.** Setup time is an external `time(1)` receipt; every LOC figure is a
  `wc -l` receipt. The one number we could *not* obtain — a live preview-URL turn — is **not** estimated; it
  is documented as a deferred artifact and labeled unverified (below), per the rule that estimates never
  masquerade as measurements.
- **§3 verification must touch reality.** eve's deploy → public-URL → `curl POST /eve/v1/session` → stream
  flow is a strong **candidate** production-grounded check: a real turn against a real deployment yields an
  externally-verifiable receipt (HTTP response + Agent Runs dashboard entry), not a self-report. The pilot
  documents the exact flow (`pilots/eve-bid/README.md`); capturing the receipt needs a deploy + a model
  credential, which #339 puts out of scope, so it is **deferred / UNVERIFIED** here.
- **§4 reversibility / irreversible-action gating.** eve's `needsApproval: always()` is a *pre-execution*
  human gate (the run parks at `session.waiting` before `execute` runs), which is exactly what §4 demands of
  a money/irreversible action — stronger than the bespoke "no spend tool + external #13 queue" because the
  gate is on the tool and survives crashes/redeploys durably. No irreversible action was taken by this spike.
- **§6 injection defense unchanged.** The pilot's tool inputs are typed scalars validated by Zod, so a
  poisoned web read can only land as plan *data*, never an actuation; the dry spend stub has no live-provider
  path. The bespoke web/spend separation is untouched (nothing was rewired).

## Findings

1. **The conventions already match** — and eve adopts the Agent Skills standard verbatim ("a skill authored
   against that standard ports over as-is"), so our `knowledge.md` / `runbook.md` ported with body intact
   (only the routing-hint frontmatter changed). Low-friction.
2. **eve gives us, for free, three things we hand-build:** durable sessions, a native HITL approval gate
   (our #13/#243), and observability + a deployable preview URL (a #200 §3 verification surface).
3. **The approval-gate mapping is the strongest fit.** ipop's whole external-send discipline (#123/#243)
   collapses onto one declarative `needsApproval` per money/send tool.
4. **The costs are real and not in this spike's blast radius:** eve is young (`0.x`, AI-SDK v7 *beta*,
   `@typescript/native-preview` toolchain), it assumes Vercel for the best path (AI Gateway, Workflow,
   Sandbox), and a fleet migration means re-homing the #68 runtime, the seeder, the @mention router, the
   semantic-layer wiring, the eval gate, and our auth/identity — none of which the pilot exercised.

## Decision — conditional GO

**Adopt the eve *conventions* now; defer a fleet *runtime* migration behind one explicit gate.**

- **Now (no migration):** keep this pilot as a living reference. It costs nothing in prod and proves the
  shape. Treat eve's deploy→preview→real-turn flow as the template for the #200 §3 production-grounded
  verification artifact.
- **Gate for a real migration (all must hold):** (a) the deferred preview-URL receipt is actually captured —
  a deployed @bid pilot completes a real turn AND its spend pauses at `session.waiting` for approval,
  observed in the stream + Agent Runs; (b) eve reaches a stable (non-beta) AI-SDK/runtime line; (c) a
  spike proves the semantic-layer + eval-gate + auth/identity wiring re-homes onto eve without weakening the
  injection boundary (#200 §6) or the eval colocation latch (#155). Until (a)–(c), **no-go on migrating the
  fleet** — the bespoke runtime stays the source of truth.

This is a one-venture-deep, reversible step: a parallel pilot + a parity test, nothing irreversible, the
go/no-go pinned to a real receipt rather than this spike's enthusiasm (#200 §7).

## Consequences

- A new isolated `platform/pilots/` tree (first occupant: `eve-bid`), excluded from build/typecheck/lint.
- One new server unit test guards parity; if @bid's bespoke invariants change, the test flags the pilot as
  drifted (intended — it pins the port to the live source of truth).
- No migration, no production change, no new prod dependency, no schema/migration.
