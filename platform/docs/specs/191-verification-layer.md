# Spec: Reload Platform — Deliverable Verification Layer: nothing ships unverified (Issue #191)

> Implements [#191](https://github.com/gagan114662/agent-skills/issues/191) and answers §2-4 of the
> premortem [#200](https://github.com/gagan114662/agent-skills/issues/200). **Builds on #13** (the pure
> approval-policy engine + `approval_requests` queue + append-only `approval_events` audit — the
> proof-card + escalation sink), **#17** (the per-workspace kill switch + the pure-`decide` /
> IO-orchestrator / config-default-OFF pattern), **#106** (the pure-registry + IO-runner + escalate-to-#13
> shape this mirrors), **#59/#36** (the separate-persona session the independent grader spawns), and
> **#25** (the secret redactor). Lifecycle: DEFINE artifact → atomic plan → TDD failing-first → ADR → one
> PR. **Video gate waived by the owner per the #106 precedent.**

## Objective

The owner directive is "on autopilot 24×7 **without mistakes**." Code already has CI; the deliverables
that reach customers do not. Today an agent's own claim of "done" is the only check on a piece of
outbound content, a support reply, a campaign change, or a venture deploy — the worker grades its own
homework. This adds **CI for everything else**: before a deliverable can request approval or auto-send, a
SEPARATE verifier grades it against a definition of done that was written *before* the work ran, and the
verdict + proof attach to the approval card.

The premortem (#200) sets the bar above "add a verifier":

- **§2:** metrics may only be backed by external receipts; an estimate is UNVERIFIED and never clears a
  gate alone.
- **§3:** production-grounded checks (real spawns, click-throughs, canaries) are the only *final* tier.
- **§4:** reversibility classes (reversible / cheap / IRREVERSIBLE); an irreversible action is
  pre-committed or human-gated, never post-hoc reviewed.

## Acceptance criteria (from #191) → where it lives

1. **Define done before doing.** `verification/criteria.ts` purely derives a `DefinitionOfDone` from the
   deliverable kind + brief; `VerificationEngine.defineDone()` persists it to `verification_criteria`,
   readable at `GET /workspaces/:wid/verification/criteria/:ref`.
2. **Independent verifier pass.** `IndependentGrader` is a seam (production = a #59 subagent under a
   different member id). `grade.ts` records `independenceOk`; `decide.ts` makes a non-independent verdict
   only ever escalate. The verdict + per-check proof attach to the #13 card.
3. **Fail → fix loop.** `decide.ts` returns `return_to_worker` with the specific failed checks within a
   bounded `maxRetries`, then `escalate` to the decision queue.
4. **Show the proof.** The #13 request payload carries criteria + per-check pass/fail + confidence; the
   summary reads "N/M checks passed, confidence X" — receipts, not a bare "ready".
5. **Applies to** outbound content, support replies, campaign changes, venture deploys (the
   `DeliverableKind` taxonomy). Code keeps its CI; this is the gate for the rest.

## Design

### Deliverable kinds + reversibility (the blast-radius floor)

`DeliverableKind = outbound_content | support_reply | campaign_change | venture_deploy`. Each has a
reversibility *floor* a caller hint can only tighten, never loosen:

| kind | floor | why |
|------|-------|-----|
| `outbound_content` | irreversible | a public/external send cannot be unsent (deliverability + brand) |
| `support_reply` | reversible | 1:1, can be followed up / corrected |
| `campaign_change` | cheap | can be paused, but spend may already be incurred |
| `venture_deploy` | irreversible | touches money / legal / brand |

### Definition of done (pure)

`deriveDefinitionOfDone({ kind, brief })` → a deterministic set of `SuccessCriterion` (each `content` /
`metric` / `production`, `required` or advisory) + the reversibility class. `validateDefinitionOfDone`
rejects a definition with no required criterion (a gate with nothing required is theatre).

### The grade (pure)

`gradeDeliverable(definition, observations, identity) → VerificationVerdict`. Per criterion:

- `content` → the grader's verdict;
- `metric` → passes **only** with an external-receipt-backed claim (`isVerifiedMetric`) — §2;
- `production` → passes **only** on production-grounded evidence — §3;
- a missing observation for a required criterion → fail.

`passed` iff every required check passed; `confidence` is the **min** over required checks; `independenceOk
= graderMemberId ≠ workerMemberId`; `productionGrounded` iff every required production check was grounded.

### The decision (pure)

`decideVerification(verdict, definition, caps, retryCount) → { action }`:

1. `!independenceOk` → **escalate** (the worker cannot grade itself).
2. `!passed` → **return_to_worker** within budget, else **escalate**.
3. production grounding required but missing → **return_to_worker** within budget, else **escalate**.
4. `irreversible` → **request_approval** (always human-gated — §4).
5. passed but `confidence < minConfidence` → **request_approval** (no low-confidence auto-send — §2).
6. `reversible` + `autoSendReversible` → **auto_proceed** (the only auto path; `cheap` never auto).
7. else → **request_approval**.

`auto_proceed` is the *only* way past the gate without a human, and it is reachable only for a verified,
reversible, opted-in deliverable — so nothing ships unverified.

### IO engine + persistence

`VerificationEngine` orchestrates: `defineDone()` (derive + persist), `verify()` (run the independent
grader → grade → decide → apply the one side effect → persist the verdict). Seams: `DefinitionStore`,
`VerdictStore`, `IndependentGrader`, `VerificationApprovalSink` (#13), `WorkerFeedback`, `caps`,
`killSwitch`, `redact`. Two append-only tables (migration `0191_`): `verification_criteria`,
`verification_verdicts`. Soft refs everywhere except `workspace_id` (the #3 tenant boundary); free-form
text redacted (#25).

### Config (default-OFF, owner first)

`verification.{enabled, minConfidence, maxRetries, autoSendReversible, requireProductionGrounding}` — all
optional, `enabled` default false. Conservative rails by default: `autoSendReversible: false`,
`requireProductionGrounding: true`. Added to the `mergeSettings` + `mergeLayers` allowlist (a higher
config layer fully owns the block, so a managed tenant's rails can't be loosened).

### Read surface (read-only proof)

- `GET /workspaces/:wid/verification/verdicts` — durable verdicts (the per-check proof), most-recent
  first, filterable by deliverable / status.
- `GET /workspaces/:wid/verification/criteria/:ref` — the latest definition of done for a deliverable.

Both #19-guarded (tenant-scoped). No mutations: verdicts are written at the chokepoint; remediation flows
through #13.

## Out of scope (additive follow-ups)

- Replacing every send-site call with `verify()` (marketing / voice / campaign / deploy adopt it
  additively — this PR ships the layer + one demonstrable chokepoint + the read API + the #13 proof path).
- The real #59-subagent grader (the default grader abstains — it never passes — until one is wired).
- Auto re-driving the worker session on a fail→fix (a logged `WorkerFeedback` seam → a #53 steer).

## Test plan

- **Unit (pure):** `caps`, `criteria` (reversibility floor + derivation + validation), `grade` (metric
  needs receipt, production needs grounding, independence, min-confidence, missing-observation fail),
  `decide` (all seven branches incl. irreversible-never-auto + bounded retries).
- **Unit (engine):** in-memory seams — defineDone persists; disabled = no-op; verified reversible opens a
  card; self-grade escalates; failure returns to worker with failures; budget exhaustion escalates;
  auto_proceed only when opted in; irreversible human-gated.
- **Integration:** real engine over the real repos + real #13 `createRequest` + Postgres — defineDone
  readable via route, verified deliverable opens a real `verification.review` card with the proof payload,
  failure returns to worker + persists, read route tenant-scoped (stranger → 403).
