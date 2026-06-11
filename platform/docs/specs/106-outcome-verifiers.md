# Spec: Reload Platform — Outcome Verifiers: measured gates for the claims without test suites (Issue #106)

> Implements [#106](https://github.com/gagan114662/agent-skills/issues/106). Phase 5 — quality for the
> 24/7 fleet. **Builds on #13** (the pure approval-policy engine + `approval_requests` queue +
> append-only `approval_events` audit — the escalation sink), **#17** (the per-workspace kill switch
> + the pure-`decide` / IO-orchestrator / config-default-OFF tick pattern shared by #96/#105/#112/#117),
> **#99** (the maintenance flag every infra-time loop self-gates on), and **#25** (the secret redactor).
> Consumed by **#96** (the venture scorecard), **#117** (flywheel fix-held closure), and **#119** (the
> evidence-priced autonomy pricer). Lifecycle: **DEFINE** artifact (`spec-driven-development`) → atomic
> plan → TDD failing-first → ADR → one PR. **Video gate waived by the owner.**

## Objective

**Premortem #7:** agents excel where verification is cheap — a test suite turns "is it correct?" into a
green/red bit. But the claims that actually decide whether a venture is real have **no test suite**: is
the deploy actually live, did a real revenue event land (not a fake-door click), did a growth metric
actually move, did a fix actually hold? Today those are asserted ("looks deployed", "should convert")
and quality plateaus at *plausible*. This replaces "looks good" with a **measured gate**.

**What:** A **verifier registry** where every non-code claim gets a measurable check. Each verifier kind
is a **pure module** that, given a measured *observation*, decides pass/fail against a threshold — no IO,
fully unit-tested. An **IO runner** runs on infrastructure time (the #17 tick pattern): it gathers the
observation through a seam, evaluates it through the pure registry, and writes the verdict as a
**durable evidence row**. A **failed verification never silently passes** — it opens a #13 escalation.
The whole loop is **kill-switch gated** and **config default-OFF**.

### Verifier kinds (the registry)

A bounded, stable taxonomy (part of the metric label + a CHECK constraint). Each is a pure
`(claim, observation) → VerifierOutcome` function:

1. **`deploy_live`** — *is the deploy actually reachable + healthy?* Observation = `{ httpStatus,
   healthy }`. Passes when `healthy` and the status is 2xx. The measured value is the HTTP status; the
   threshold is "2xx + healthy". Closes the gap a #73 "deployment created" row leaves open.
2. **`revenue_real`** — *did a real revenue event land?* Observation = `{ realEventCount }` — the count
   of **settled** #98 revenue events for the claim (a webhook-verified `payment` / `subscription`
   event), explicitly **not** a #101 fake-door click. Passes when `realEventCount ≥ target` (≥ 1).
3. **`growth_metric`** — *did the metric actually move?* Observation = `{ currentValue, baselineValue }`.
   The measured value is the delta `current − baseline`; passes when `delta ≥ target` (the metric moved
   past the threshold, not noise).
4. **`fix_held`** — *did the fix hold?* Observation = `{ recurrenceCount }` — recurrences of the fixed
   failure since the fix landed (the #117 flywheel's signal). Passes when `recurrenceCount == 0`. This
   is the FINAL verifier the directive calls out: a fix isn't "done" when the PR merges, it's done when
   the failure stays gone.

The registry is **open for extension**: a new kind is a pure function + a taxonomy entry + a threshold
shape; the runner, schema, escalation, and read API are kind-agnostic.

## Architecture (pure decision in, side effects out)

Mirrors `venture/` (#96), `watchdog/` (#105), `sre/` (#112), `flywheel/` (#117):

- **`verifiers/types.ts`** — the `VERIFIER_KINDS` taxonomy, `VerifierClaim` (what to verify + the
  threshold + the soft `claimRef`), the per-kind `Observation` union, `VerifierOutcome` (passed +
  measured value + threshold + detail), the durable `VerifierResultRecord`, and the decision types.
- **`verifiers/registry.ts`** — the pure registry: one verifier function per kind + `evaluateClaim(claim,
  observation) → VerifierOutcome` dispatch. **No IO, no clock, no randomness** — a given (claim,
  observation) always yields the same outcome, which is what makes "the gate is measured" a property of
  the code rather than a hope. Also the pure consumption reducer `summarizeOutcomeEvidence(results)`.
- **`verifiers/decide.ts`** — `decideVerification(outcome, caps) → { action: "record_pass" |
  "escalate" | "skip"; reason }`. A pass records; a fail escalates (when escalation is enabled); an
  errored observation skips (no false verdict from a probe that couldn't measure).
- **`verifiers/guards.ts`** — the pure threshold predicates the registry composes.
- **`verifiers/caps.ts`** — `resolveVerifierCaps(config) → VerifierCaps` with hard defaults (default
  **OFF**, `escalateOnFailure: true`, `maxPerTick`).
- **`verifiers/engine.ts`** — `VerifierRunner`: the IO orchestrator. `verify(workspaceId, claim)`
  gathers the observation (seam), evaluates (pure), persists the evidence row (seam), and on failure
  opens a #13 escalation (seam) — recording the escalation's request id on the row. `tickWorkspace`
  runs the due claims for a workspace; `tickAll` sweeps active workspaces. Gating is identical to the
  other loops: **maintenance (#99) before any DB call**, then per-workspace the `enabled` flag and the
  **#17 kill switch**.
- **`verifiers/default.ts`** — production wiring: real observation probes (deploy fetch / #98 revenue
  rows / metric source / #117 recurrence count), the #13 escalator (`createRequest`, `actionType:
  "verifier.failed"`), and the `verifier_results` repo store. Default-OFF; wiring it changes nothing.

### Durable evidence rows (migration `0106_`)

One additive, **append-only** table `verifier_results` — no existing table is touched:

| column | meaning |
|---|---|
| `id`, `workspace_id` (FK cascade) | identity + #3 tenant boundary |
| `kind` | one of `VERIFIER_KINDS` (CHECK-constrained) |
| `claim_ref` | **soft ref** to the thing verified (deployment id / venture id / fingerprint id) |
| `status` | `passed` \| `failed` \| `errored` (CHECK-constrained) |
| `measured_value`, `threshold` | the numbers behind the verdict |
| `detail` | a short, **redacted** (#25) human summary |
| `escalation_request_id` | the #13 request opened on failure (soft ref, null on pass) |
| `source` | free-form provenance tag |
| `created_at` | append time |

Index `(workspace_id, kind, claim_ref, created_at)` backs the "latest verdict for this claim" read.

### Escalation — failed verifications never silently pass

On a `failed` outcome (and `escalateOnFailure`), the runner enqueues a #13 approval via the `Escalator`
seam (`createRequest`, `actionType: "verifier.failed"`, summary carrying kind/claim/measured/threshold)
and stamps the returned `request_id` onto the evidence row. The default sink is the same #13 queue the
SRE loop escalates to, so a failed gate surfaces wherever approvals already surface (#104). An
escalation that can't be enqueued (no requester member) is logged and the row stays `failed` — the
verdict is never lost.

### Consumed by #96 / #117 / #119

Verifier evidence is the shared signal three subsystems read (via the repo read API +
`summarizeOutcomeEvidence`):

- **#96 venture scorecard** — a venture isn't "done" when CI is green; it's done when its
  `deploy_live` / `revenue_real` / `growth_metric` verifiers have passing latest rows. The scorecard
  reads `latestResult(workspaceId, kind, claimRef)`.
- **#117 flywheel closure** — `fix_held` is the outcome verifier that confirms a merged fix held; a
  failed `fix_held` (recurrence) is exactly the recurrence that reopens the fingerprint escalated.
- **#119 evidence-priced autonomy** — a sustained record of passing outcome verifiers for an action
  class is evidence the agent earned the boundary; a `failed` verifier is counter-evidence. The pricer
  reads the same trailing window.

The read surface is exposed read-only at `GET /workspaces/:wid/verifier-results` (#19 tenant-guarded),
mirroring the SRE incidents route.

## Non-goals

- **No new probe infrastructure.** The default probes read existing surfaces (#73 deployments, #98
  revenue rows, #112 `/metrics`, #117 recurrences); a real external uptime checker is a later seam.
- **No rewrite of #96/#117/#119 internals.** This ships the evidence rows + the read API those systems
  consume; the deeper in-loop wiring is additive follow-up on the seam provided here.
- **No scheduler.** The tick is opt-in (`VERIFIERS_INTERVAL_MS`, default 0); tests/CI drive
  `tickWorkspace()` / `verify()` deterministically, exactly like the venture/SRE/flywheel ticks.

## Test plan (TDD, failing-first)

- **Unit — registry:** each kind passes/fails at its threshold boundary; deterministic; an unknown kind
  throws. `summarizeOutcomeEvidence` reduces a mixed result set to pass-rate + latest-per-claim.
- **Unit — decide:** pass → `record_pass`; fail → `escalate` (and `skip` when `escalateOnFailure` off);
  errored → `skip`.
- **Unit — caps:** default OFF + hard defaults; config overrides; managed-layer lock.
- **Unit — engine:** persists a row per verify; opens exactly one escalation on failure and stamps the
  request id; **no escalation on pass**; kill switch + `enabled:false` + maintenance each short-circuit
  before any store/escalator call; `errored` observation persists `errored` and never escalates.
- **Integration (real Postgres):** the runner over the real `verifier_results` repo + the real #13
  `createRequest` — a failing `deploy_live` writes a `failed` row AND an `approval_requests` row linked
  by `escalation_request_id`; a passing `revenue_real` writes a `passed` row with no approval; the read
  route returns them tenant-scoped.
