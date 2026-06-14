# ADR-0195: Venture Deploys — the fleet ships venture products to production itself

- **Status:** Accepted (shipped in PR for #195)
- **Date:** 2026-06-14
- **Context issue:** [#195](https://github.com/gagan114662/agent-skills/issues/195)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — production-grounded
  verification is the only final tier (§3: a real deploy + a real smoke probe of the live URL is the
  only path to a customer-facing promote); irreversible infra actions are pre-committed or human-gated,
  never reviewed post-hoc (§4: the prod cutover is gated/pre-committed, the auto-rollback is the
  pre-committed bounded safety action).
- **Builds on:** [ADR-0187](0187-venture-factory.md) (the venture-factory bootstrap loop + the reversible
  `repo_deploy_target` step — the seam this hangs the provisioner on), [ADR-0041](0041-deploy-to-live-url.md)
  (the #73 `DeployProvider`/`DeployManager` adapter — immutable deployment rows, rollback re-promotes a
  prior one, dry-run default), [ADR-0171](0171-self-qa-loop.md) (the #171 http smoke driver + suite catalog —
  the production-grounded release gate), [ADR-0172](0172-self-shipping-loop.md) (the build-loop's optional
  `PostMergeVerifier` seam this attaches to), [ADR-0174](0174-self-healing-ops.md) (the #193 `filePostmortem`
  reporters + reversibility classes this reuses to file a release incident), [ADR-0192](0192-external-account-onboarding.md)
  (the per-tenant write-only vault — per-venture deploy secrets), [ADR-0173](0173-founder-briefings.md) (the
  daily-brief seam + the optional-input / default-OFF / pure-core-IO-orchestrator pattern this mirrors),
  [ADR-0099](0099-disaster-recovery.md) (by-issue migration numbering).

> **Numbering note.** Migration/ADR both use the `0195` slot (the issue number), per the by-issue numbering
> convention (ADR-0099's note) — to dodge sibling-workspace collisions in the shared migration sequence. Do
> **not** renumber to the next sequential slot.

## Context

A venture's product is software, but nothing took it from repo to live URL without a human. The factory
(#187) plans a reversible `repo_deploy_target` bootstrap step but runs it as a no-op; #73 can deploy a
session's app but is channel-scoped, single-target, and never wired to a venture; #172 self-ships
agent-skills itself but has no deploy step in-process (it lives in the `fly-deploy.yml` CI lane). The
owner's directive: when a venture's product is software, the fleet ships it to production **inside the same
gates that protect ipop itself** — provisioned, gated, rolled back, receipted.

The premortem (#200) is the governing constraint and makes the naive version wrong:

- **Verification must touch reality (§3).** A worker+verifier that both read green CI can ship a broken
  prod (#166). The ONLY path to a customer-facing promote is: the deploy succeeded AND a smoke actually
  ran against the live preview URL AND found zero critical findings. A release that did not smoke-test
  reality is never promotable — `smoke_critical_count = -1` ("did not run") is never a pass.
- **Reversibility classes (§4).** Provisioning a preview target and deploying a build are **reversible**
  (tear-down-able / rollback-able) → autonomous. A rollback is **cheap** and is the pre-committed safety
  action. The prod cutover is customer-facing → **gated by default** (`requireApprovalForProdPromote`),
  autonomous only once the owner **pre-commits** (`preCommitProdPromote`) — a pre-commitment, never
  post-hoc review.

## Decision

A new `venture-deploy/` module, **default OFF** behind a `ventureDeploys` config block, **owner-workspace
first**, mirroring #187/#193 (pure decision core + injected IO seams).

### 1. Provisioning (AC1) — hooks the #187 factory bootstrap seam

The factory's `VentureFactoryDeps` gains an optional `deploy?: DeployTargetProvisioner`, and the autonomous
bootstrap loop gains a `case "repo_deploy_target"` branch. **Optional ⇒ OFF/unwired is byte-for-byte
today's behavior.** `VentureDeployProvisioner`:

- **Idempotent** — keyed on the `(workspace_id, venture_id)` unique target row; a re-run short-circuits.
- **Budget-capped** — infra spend is charged through the venture's #71 tenant ceiling (the same accounting
  the factory charges scans against) AND a hard per-venture `infraSetupCapCents`.
- **Tenant-scoped at the infra layer (AC5)** — each venture gets its OWN `projectId` (a separate Fly app /
  Vercel project) and its OWN vault service-key (`venture-deploy:<ventureId>`, the #192 composite-PK vault).
  A release for venture A can only ever resolve venture A's target, so there is no cross-venture infra access.
- The infra backend is a `VentureInfraProvider` adapter: **`DryRunInfraProvider`** (default, no spend) +
  dependency-free, lazy, token-gated **Fly** and **Vercel** REST adapters.

### 2. The release pipeline (AC2/AC3) — generalizing the ship-loop

`VentureReleasePipeline`: **deploy the merged build to the preview target (#73) → smoke the live preview URL
(#171) → `decideRelease` → promote / auto-rollback / escalate → write an immutable receipt + file a #193
incident on failure.** It is attached to the build-loop's existing optional `PostMergeVerifier` seam via
`releasePipelineAsPostMergeVerifier`; a non-venture run (agent-skills' own self-shipping) resolves no venture
and is a byte-for-byte no-op, so wiring it in is safe. A broken image is auto-rolled-back without a human
(AC3) — the `autoRollbackOnSmokeFail` cap IS the pre-commitment — and never reaches customers (the gate sits
on preview, prod is cut over only after a green smoke).

### 3. Receipts + brief (AC4)

The immutable `deploy_releases` rows ARE the audit trail (every deploy/smoke/promote/rollback). An optional
`ventureDeploys` section is added to the daily brief (empty default → unchanged), summarizing promotes /
rollbacks / releases needing the owner.

### Schema & governance

Two additive tables, `deploy_targets` + `deploy_releases` — deliberately **not** `venture_*`-prefixed so the
colocation governance check (`GOVERNED_TABLE_RE`) does not class them as metric surfaces (the #192/#194
`external_*`/`finance_*` precedent); they are infra receipts, not scorers. `venture_id` is a soft ref (no FK)
so a receipt outlives a pruned venture. Migration `0195_venture_deploys.sql` (+ `.down.sql`), verified
up/down/up on a throwaway DB.

## Consequences

- **Positive.** The factory can now stand a software venture up to a live URL autonomously, behind the same
  gates as ipop: production-grounded release gate, autonomous rollback, owner-gated cutover, full receipts.
  Everything is default-OFF and owner-workspace-first; the pure decision core is exhaustively unit-tested.
- **Follow-ups (honest seams).** The default release `deployer` is the no-spend dry-run backend; a runner
  image points it at a venture-scoped #73 `DeployManager` for real Fly/Vercel pushes. The build-loop verifier
  is attached but inert until a venture-run registry (`resolveVenture`) maps build-loop runs to ventures —
  mirroring the factory's own "real injections are a follow-up" pattern. Custom-domain cutover (irreversible)
  stays on the factory's MONEY/#192 DNS path, not this pipeline.
- **Negative / risk.** A second deploy concept (`deploy_targets` for target provisioning vs #73 `deployments`
  for per-push deploys) — kept distinct because target creation and build deploys have different lifecycles
  and reversibility. The real Fly/Vercel adapters are untested in CI (no cloud account), exactly as the #73
  Vercel adapter is — the dry-run path carries the test coverage.
