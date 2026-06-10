# ADR-0049: The Venture Loop — a YC-Fundability Gate for Autonomous Work

- **Status:** Accepted (owner waived the video gate — issue #96)
- **Date:** 2026-06-10
- **Context issue:** [#96](https://github.com/gagan114662/agent-skills/issues/96) (Phase 5 — governance for the 24/7 fleet)
- **Builds on:** [ADR-0017](0017-autonomy.md) (autonomy engine: pure `decide`/`guards` + IO
  orchestrator, kill switch), [ADR-0042](0042-autonomy-real-sessions.md) (real agent sessions /
  `AutonomyLauncher`), [ADR-0040](0040-cloud-scale.md) (admission chokepoint + tenant usage/budget),
  [ADR-0035](0035-config-layering.md) (managed/per-tenant config), #59 (subagent personas), #13
  (approvals), #15 (memory graph). Defers: live-research evidence + an LLM-backed #59 persona scorer.

## Context
The platform can now run agents 24/7 (#17/#84/#80), but nothing stops them from burning build budget
on cheap demos/MVPs. Before autonomy commits a build cycle to an idea, the idea should clear a
**venture bar**. We want a loop-engineered gate (act → observe → reason → repeat, with explicit
termination, structured feedback, budgets, and escalation) that scores an idea against a YC-grade
rubric and only unlocks autonomy budget for **fundable** ideas — recording KILLs so they are not
blindly retried, and escalating borderline calls to a human.

## Decisions

1. **A `venture/` module mirroring the #17/#80 shape: pure core + IO orchestrator + thin route.**
   `decide.ts` (`decideVenture`) is the **single source of truth** for FUND/ITERATE/KILL/ESCALATE,
   given a score + loop state + config thresholds — no IO, fully unit-tested. `service.ts` is the IO
   orchestrator; `routes/venture.ts` is a thin `requireIdentity` + `assertWorkspace` adapter. Every
   collaborator (evidence, persona scorer, #13/#14/#15 effects, usage, kill switch) is an injected
   seam, so the loop runs against fakes with no DB and no model spend.

2. **Decision priority: hard verdicts before loop state.** `score ≥ fund → FUND`; `score ≤ kill →
   KILL`; a borderline band just below fund → ESCALATE (human judgment). Only in the improvable
   **mid-band** do the termination conditions apply, in order: **dollar budget exhausted → max
   iterations → no-novel-angle**, each → ESCALATE. A FUND-worthy score still FUNDs even if the budget
   ran out (the work is done); we only refuse to spend *more* iterating.

3. **Dual-persona adversarial scoring (#59).** An **Advocate** and an adversarial **Reviewer** each
   score the eight YC-bar dimensions (from `skills/idea-refine`); the combined score weights the
   Reviewer higher (default 0.6), so the gate is conservative by construction. The persona prompts
   live in `venture/personas.ts`; the shipped scorer is a deterministic stand-in (no model spend) and
   an LLM-backed #59 scorer that runs those prompts is the deferred follow-up.

4. **The anti-demo admission gate is autonomy-only and config default-OFF.** `decideVentureAdmission`
   is pure (admit unless enabled-and-no-passing-unexpired-scorecard). `ventureGatedLauncher`
   decorates the **`AutonomyLauncher`** (not the generic `SessionManager`), so the loop's own
   Advocate/Reviewer persona sessions are never blocked by the gate they exist to satisfy (no
   chicken-and-egg deadlock), and human/interactive launches are never gated. Because the gate
   short-circuits to admit when the per-workspace flag is off, wrapping the default launcher is a
   no-op for every existing workspace — behavior is unchanged until an operator opts in.

5. **Durable loop state (no in-memory-only loop).** A `venture_evaluations` row per idea persists the
   resume cursor — current iteration, the failed angles, the last score, accrued cost, and the
   terminal verdict. A crash/restart resumes from the row; a finished evaluation is never re-run.
   The scheduled tick reads `status='active'` rows as its work-list.

6. **The dollar ceiling reuses the #71 tenant-usage accounting.** Each scoring pass charges an
   estimated cost to the SAME `tenant_usage` window that bounds session spend, and the SAME
   `budgetExceeded(spent, scale.budgetCents)` cap decides exhaustion. An evaluation that exhausts the
   tenant budget terminates **ESCALATE**, and the advance route answers **402** — identical semantics
   to an over-budget session launch. One tenant budget bounds sessions and ventures together.

7. **Infrastructure time.** Evaluations advance on a scheduled `VentureEngine` tick (opt-in
   `VENTURE_INTERVAL_MS`, default off, started in `index.ts`), not only on human route calls.
   Submitting an idea opens its evaluation so the tick picks it up. Each `advance` self-gates on the
   #17 kill switch, so the same hard stop that halts autonomy halts venture evaluation.

## Consequences
- **Positive:** autonomy budget only flows to ideas that cleared the bar; KILLs are remembered in the
  #15 graph; borderline calls escalate to a human; the loop is crash-resumable and dollar-bounded;
  default-OFF means zero behavior change until opted in; the pure gate makes every required path a
  fast unit test.
- **Negative / deferred:** the shipped evidence gatherer and persona scorer are deterministic
  stand-ins — real web research and an LLM-backed #59 scorer are follow-ups (the loop, persistence,
  gate, budget, and tick are real). v1 gates at **workspace granularity** (an enabled workspace needs
  ≥1 passing unexpired scorecard); per-epic/per-task binding is a follow-up.

## Alternatives considered
- **Gate in `SessionManager.launch` (like #80 admission).** Rejected: it would block the venture
  loop's own persona sessions (deadlock) and all interactive launches. Gating the `AutonomyLauncher`
  scopes enforcement to exactly the autonomous build launches the gate is meant to govern.
- **A separate venture budget.** Rejected for v1: the issue asks for the *existing* tenant-usage
  accounting and the *same* 402 semantics, so sessions and ventures share one tenant budget.
- **In-memory loop with reconstruct-on-restart.** Rejected: the requirement is explicit durability; a
  `venture_evaluations` cursor is simpler to resume and gives the tick a cheap work-list.
