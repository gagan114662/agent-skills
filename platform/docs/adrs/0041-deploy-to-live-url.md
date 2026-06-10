# ADR-0041: Deploy agent-built apps to a live URL — integrate a provider adapter

- **Status:** Accepted (Gagan approves defaults-and-go on the demo video — issue #73)
- **Date:** 2026-06-09
- **Context issue:** [#73](https://github.com/gagan114662/agent-skills/issues/73) (Feature phase 5 — part of EPIC #60)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (the `SandboxProvider` adapter seam + lazy Vercel
  SDK + per-tenant `SecretsResolver` + value redaction), [ADR-0033](0033-run-preview-spotlight.md)
  (a manager **separate** from `SessionManager`, channel-bus status/log events, the web tab),
  [ADR-0009](0009-registry-rbac.md) (the capability ladder + IDOR discipline), and
  [ADR-0035](0035-config-layering.md) (where the build/deploy command is declared + the egress gate)

## ⚠️ Decision first — build vs. integrate

**Decision: integrate an existing deployer behind a `DeployProvider` adapter; do NOT build managed
hosting in-house.** This issue is scoped to *the capability + the adapter*, not to running a VPS
business. Building native hosting (TLS termination, an orchestrator, autoscalers, a backup system,
on-call) is months of DevOps we would then own forever; an integration adapter ships the user value —
"agent builds it → it's live" — in one PR with **zero infrastructure to operate**. The provider already
gives us managed HTTPS, immutable deployments (our backups), rollback, health/auto-restart, and scaling;
we wrap them behind one narrow interface. The seam means a second provider (Railway / Fly / livemy.app)
is a new adapter, not a rewrite — so the choice is reversible. This is the exact trade ADR-0025 made for
execution (Vercel Sandbox behind `SandboxProvider`), reused here for deployment.

**Chosen first provider: Vercel.** `@vercel/sandbox@^2.1.1` is already a dependency (ADR-0025) and Vercel
gives managed HTTPS + immutable deployments + instant rollback + health/restart + scaling out of the box —
the whole #73 surface from one vendor. The adapter is loaded behind a **lazy dynamic import** so the SDK
stays optional and CI never touches it (same discipline as `VercelSandboxProvider`).

## Context
An agent can build an app in a session (#50/#25) and we can preview localhost in-app (#56), but there is
**no one-click path from the agent's built output to a live, shareable URL** with managed HTTPS,
monitoring, backups, and scaling. #19 deploys *the platform itself*; #56 is an in-app *preview* — neither
ships the agent's product. This ADR closes that gap: from a finished session, one click deploys its app to
a live HTTPS URL, and a redeploy is the same call.

## Decisions

1. **A `DeployProvider` adapter seam, default = a no-spend `DryRunDeployProvider`.** Mirroring the
   `SandboxProvider` seam (ADR-0025), `deploy/provider.ts` defines a narrow interface
   (`deploy / rollback / restart / scale / healthCheck`); `deploy/dry-run-provider.ts` is the **default**
   (returns a deterministic `https://<slug>.dryrun.reload.app` URL, records calls, streams synthetic build
   lines — so tests, CI, and the demo never spend); `deploy/vercel-provider.ts` is the real adapter behind
   a **lazy `await import`** gated by `DEPLOY_PROVIDER=vercel`. `createDeployProvider(env)` selects, exactly
   like `createRuntime`. Tests inject a fake provider — **zero cloud spend**.

2. **A separate `DeployManager`, NOT the `SessionManager` (and NOT the `RunProcessManager`).**
   `SessionManager` runs a harness to completion and finalizes the session row; `RunProcessManager` runs a
   long-lived *local* dev server, ephemerally. A deploy is a **third thing**: a one-shot async job
   (provision → build → publish → live URL) whose result is **durable** and outlives the request. So
   `deploy/manager.ts` is standalone, reuses the provisioner (the agent's worktree as the build source) and
   the secrets/redaction primitives, and **persists** to a `deployments` table (unlike run's ephemeral
   state) — because a live URL must survive a server restart. Same blast-radius discipline as #33/#51.

3. **A deploy is immutable; "redeploy on push" is the same call from the push trigger.** Each `deploy`
   creates a **new** retained `deployments` row (provider deployment ids are immutable) — this *is* the
   backup history. There is no in-place mutation. "Redeploy on push" is therefore not a new mechanism: the
   `#51` push/commit seam invokes `deployManager.deploy(session, { reason: "push", headSha })`, producing a
   fresh deployment. v1 ships the deploy + explicit redeploy endpoint and the push-trigger **seam**; the
   live demo drives the redeploy the same way a push would. (Auto-wiring the git push hook is a one-line
   follow-up to keep this PR off the git module.)

4. **Rollback re-promotes a prior good deployment; backups are the immutable history.** `rollback` finds the
   most recent **prior** `ready` deployment for the session and asks the provider to re-promote it
   (`provider.rollback(providerDeploymentId)`), recording a new `ready` row that points at it. Because every
   deploy is retained, the deployment list *is* the backup set — no separate backup machinery, matching how
   the provider already models it.

5. **Health monitoring + auto-restart is a per-deployment method; the periodic sweep is reserved.**
   `deployManager.checkHealth(deployment)` calls `provider.healthCheck(url)`; on failure it asks the
   provider to `restart`, re-checks, and either recovers (status back to `ready`) or marks `unhealthy` and
   **posts a report message** to the channel. This is the implemented, unit-tested auto-restart/report
   capability. The continuous background monitor is reserved as an **opt-in** interval
   (`DEPLOY_MONITOR_INTERVAL_MS`, default `0` = off) following the #17 autonomy / #55 sweep pattern; v1
   drives `checkHealth()` deterministically in tests (CI runs no timer) and wiring the periodic sweep into
   `index.ts` is a documented follow-up.

6. **One-click scaling is a bounded call onto the provider.** `scale(deploymentId, { instances?, size? })`
   clamps to limits from **trusted config** (`deploy.maxInstances`) and calls `provider.scale`. Never
   request-unbounded; the dry-run provider records it.

7. **Tenancy, secrets, and the egress gate are non-negotiable.** Every route is gated by **channel write
   capability** and resolves the session **scoped to its channel** (`getAgentSession(id, cid)`), so it is
   IDOR-safe; `deployments` rows are workspace-scoped. Provider credentials (`VERCEL_TOKEN`, …) live ONLY on
   the `SecretsResolver` path keyed by workspace — **never** in config (config holds env-var *names*, the
   #52/#57 convention). Every streamed/persisted deploy log line passes through `makeRedactor(secrets)` so a
   secret value can never appear in a log or the channel message. **A cloud deploy is off-platform egress:**
   the manager calls `egressAllowed(cfg)` first and **refuses** (`409`) when `dataPrivacyMode` is on.

## Alternatives considered

- **Build managed hosting in-house** (own the VMs/TLS/orchestrator/backups). Rejected — it's a VPS business
  outside "Slack for AI agents," months of DevOps to own, and explicitly out of scope (Decision: integrate).
- **Deploy through `SessionManager` or `RunProcessManager`.** Rejected — the former finalizes the session;
  the latter models an ephemeral local process. A deploy is a durable one-shot job (Decision 2).
- **Mutate one deployment in place on redeploy.** Rejected — immutable deployments give us rollback +
  backups for free and match every real provider (Decision 3/4).
- **Accept the build/deploy command from the request body.** Rejected — that is arbitrary RCE for any
  channel writer; the command comes from trusted layered config, the #33/#27 trust boundary (Decision 7).
- **Run the real provider in CI.** Rejected — the dry-run provider is the default and the Vercel SDK is
  lazy-imported, so CI and the demo incur zero spend (Decision 1).

## Consequences
- From a finished session, one click deploys the agent's app to a live HTTPS URL posted into the channel;
  a redeploy is the same call; rollback re-promotes a prior good deploy; an unhealthy app auto-restarts or
  reports; scaling is one bounded call — all behind a provider seam, with **no infrastructure we operate**.
- **Limitations (documented):** the real deploy requires installing `@vercel/sdk` + Vercel auth and setting
  `DEPLOY_PROVIDER=vercel` (default is the dry-run provider); auto-trigger on a git push, a second provider
  adapter, and richer monitoring dashboards are filed as follow-ups.
- New surface: `deploy/{provider,dry-run-provider,vercel-provider,factory,detect,manager,default}.ts`,
  `routes/deploy.ts`, `deploy_status`/`deploy_log` events + `publishDeployEvent`, a `deploy` config section,
  a `deployments` table + repository (migration `0073`), `DeployEnv`, and the web Deploy tab (`DeployPanel`,
  `deploy` store slice, `api.deploy`). Covered by unit tests (detection + manager with a fake provider:
  deploy/redeploy/rollback/health-restart/scale/redaction/egress), an integration test (real
  Postgres/Redis + dry-run provider: deploy → https URL → channel message → events → redeploy → rollback →
  409/403/IDOR + secret-never-in-logs), and web component tests. `pnpm -C platform typecheck && lint && test
  && build` green.

## Follow-ups (deferred)
- Wire the opt-in periodic health sweep (`DEPLOY_MONITOR_INTERVAL_MS`) into `index.ts` so `checkHealth`
  runs on an interval (Decision 5) — exactly the #17/#55 timer pattern.
- Auto-trigger a redeploy from the #51 git push/commit event (the seam is in place — Decision 3).
- A second `DeployProvider` (Railway / Fly / livemy.app) to exercise the seam.
- A monitoring dashboard + alerting beyond the opt-in health sweep; custom domains; preview-per-PR URLs.
- Per-deploy cost accounting alongside the #25 sandbox budget.
