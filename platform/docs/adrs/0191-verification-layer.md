# ADR-0191: Deliverable Verification Layer — nothing ships unverified

- **Status:** Accepted (shipped in PR for #191)
- **Date:** 2026-06-13
- **Context issue:** [#191](https://github.com/gagan114662/agent-skills/issues/191)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) (the standing "necessary but
  not sufficient" list this layer answers §2-4 of)
- **Spec:** [docs/specs/191-verification-layer.md](../specs/191-verification-layer.md)
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 approval queue + `createRequest` — the
  proof-card + escalation sink), [ADR-0017](0017-autonomy.md) (the per-workspace kill switch + the pure
  `decide` / IO-orchestrator / config-default-OFF pattern), [ADR-0106](0106-outcome-verifiers.md) (the
  pure-registry + IO-runner + escalate-to-#13 shape this mirrors), [ADR-0036](0036-subagents.md) (the
  separate-persona session the independent grader spawns), [ADR-0119](0119-evidence-priced-autonomy.md)
  (the `gate_evidence` provenance idea — receipts, not claims).

> **Numbering note.** Spec / migration / ADR all use the `0191` slot (the issue number), per the
> project's by-issue numbering convention (ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Context

The owner directive is "on autopilot 24×7 **without mistakes**." Mistakes are inevitable; *shipped*
mistakes are optional. Code already has CI — a test suite turns "is it correct?" into a green/red bit.
But the deliverables that actually reach customers have **no test suite**: a piece of outbound content, a
support reply, a campaign change, a venture deploy. Today an agent's own claim of "done" is the only
check on those — the worker grades its own homework, and quality plateaus at *plausible*.

The premortem (#200) sharpens the requirements beyond "add a verifier":

- **§2 — self-reported metrics are fiction.** A scorecard may only contain external receipts (Stripe
  events, delivery webhooks, analytics). Estimates are UNVERIFIED and must never, alone, clear a gate.
- **§3 — verification must touch reality.** Worker and verifier share blind spots (#166: green CI, broken
  prod). Production-grounded checks (real spawns, click-throughs, canaries) are the only *final* tier.
- **§4 — reversibility classes.** reversible / cheap / IRREVERSIBLE (deliverability, brand, legal, money).
  An irreversible action is pre-committed or human-gated — never post-hoc reviewed.

The hard parts are not "ask an LLM if it looks good". They are: (a) keeping the **decision pure** so "the
deliverable was graded against a spec" is a property of the code, not of a mock; (b) making the worker
**structurally unable to grade its own homework**; (c) ensuring a metric only counts with an **external
receipt** and an irreversible action **can never auto-send**; and (d) putting the **proof on the card** so
a human sees criteria + per-check pass/fail + confidence, not a bare "ready".

This is distinct from #106 Outcome Verifiers, which measures venture *outcomes* (deploy live? revenue
real?) on infrastructure time. This layer gates a *deliverable* at the moment it wants to ship.

## Decisions

1. **Done is defined before doing, as data.** `criteria.ts` purely derives a `DefinitionOfDone` (the
   success criteria + a reversibility class) from the deliverable kind + brief; the engine persists it to
   `verification_criteria` (visible per deliverable via the read route). A definition with no *required*
   criterion is rejected — a gate with nothing required is theatre (#191 AC #1).

2. **A separate verifier grades the work; the worker never grades its own homework.** The independent
   grader is a seam (`IndependentGrader`) — production spawns a #59 subagent under a *different* member
   id (ADR-0036). The pure `grade.ts` records `independenceOk = graderMemberId ≠ workerMemberId`, and the pure
   `decide.ts` makes a non-independent verdict **only ever escalate** — it can never proceed. Independence
   is an invariant of the types + decision, not a convention (#191 AC #2).

3. **The grade encodes the premortem, purely.** `grade.ts` is `(definition, observations, identity) →
   verdict` with no IO: a `metric` criterion passes **only** when its claim carries an external receipt
   (§2 — `isVerifiedMetric`); a `production` criterion passes **only** on production-grounded evidence
   (§3); a missing observation for a required criterion is a fail; confidence is the **min** over required
   checks (the weakest link). A given (definition, observations) always yields the same verdict.

4. **One pure decision, four actions, no silent pass.** `decide.ts` is `(verdict, definition, caps,
   retryCount) → action`. `auto_proceed` is reachable **only** for a verified, *reversible*, opted-in
   deliverable — `cheap` and `irreversible` never auto-proceed (§4), and a low-confidence pass never
   auto-proceeds (§2). A failure returns to the worker with the specific failures, then escalates after a
   bounded retry budget (#191 AC #3). Every non-`auto_proceed` path opens a #13 card or returns to the
   worker — there is no fourth way past the gate, so nothing ships unverified.

5. **The proof rides the approval card.** On `request_approval`/`escalate` the engine opens a #13 request
   whose payload carries the criteria + per-check pass/fail + confidence + reversibility, and whose
   summary reads "N/M checks passed, confidence X" — receipts over a bare "ready" (#191 AC #4), enforced
   in the product.

6. **Two additive, append-only tables (migration `0191_`).** `verification_criteria` (the definition of
   done) and `verification_verdicts` (each independent pass, with the per-check proof, the independence +
   production-grounded bits, the retry count, and the #13 request it opened). No existing table is touched
   (zero sibling-migration collision risk). `deliverable_ref` / `worker_member_id` / `grader_member_id` /
   `approval_request_id` are **soft references** (no FK) so a verdict outlives a pruned subject; only
   `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`). Free-form text is redacted (#25)
   before persist.

7. **Default-OFF, kill-switch-gated, owner workspace first.** `verification.enabled` defaults false, so
   decorating the engine on `app` changes nothing until a deployment opts in. The conservative rails are
   the defaults: `autoSendReversible: false` (a verified deliverable still waits for a human) and
   `requireProductionGrounding: true` (the §3 final tier is required where it applies). Each `verify()`
   checks `enabled` then the #17 kill switch. The default production grader **abstains** (it cannot confirm
   anything → nothing passes) until a real #59 grader is wired — an unverified claim is never trusted.

## Consequences

- **Positive:** an agent's "done" is no longer the only check on a deliverable; the worker is
  structurally unable to grade its own homework; an estimate can never masquerade as a verified metric; an
  irreversible action can never auto-send; the human sees the proof, not a claim; the verdict is durable +
  tenant-scoped + redacted; zero behavior change until opt-in.
- **Negative / trade-offs:** this PR ships the layer + persistence + read API + the #13 proof path and
  wires it as a decorated engine + one demonstrable chokepoint — it does not yet replace every send-site's
  call with `verify()` (the marketing/voice/campaign/deploy paths adopt it additively, mirroring how #106
  shipped rows + read + one escalation path, not a rewrite of every loop). The default grader abstains,
  so a deployment must supply a real #59-subagent grader to grade for real; until then, opting in blocks
  rather than ships (the safe direction). Re-driving the worker session on a fail→fix is a logged seam
  (`WorkerFeedback`) a deployment wires to a #53 steer.
- **Neutral:** mirrors the established shape (pure `criteria`/`grade`/`decide` + IO engine + config
  default-OFF + escalate-to-#13), so it carries no new architectural concept — it carries the premortem's
  rules into the type system.
