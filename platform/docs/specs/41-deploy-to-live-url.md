# Spec: Reload Platform — Deploy agent-built apps to a live URL (Issue #73)

> Implements [#73](https://github.com/gagan114662/agent-skills/issues/73). Feature phase 5 —
> part of EPIC #60. Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills
> way — every stage governed by a skill in `skills/`. Builds on [#25](25-cloud-execution.md) (the
> `SandboxProvider` adapter seam, lazy Vercel SDK, per-tenant `SecretsResolver` + value redaction),
> [#56](33-run-preview-spotlight.md) (a manager **separate** from `SessionManager`, channel-bus
> status/log events, the web tab), [#9](09-registry-rbac.md) (capability ladder + IDOR), and
> [#58/#35](35-config-layering.md) (where the deploy command is declared + the data-privacy egress gate).

## ⚠️ Decision first — build vs. integrate
**Integrate a provider adapter; do not build managed hosting in-house.** See
[ADR-0041](../adrs/0041-deploy-to-live-url.md). This issue is scoped to the *capability + the adapter*,
not to building a VPS business. The first provider is **Vercel** (already a dependency via #25), loaded
behind a lazy import; the **default** provider is a no-spend dry-run that fully exercises the surface so
tests/CI/the demo never spend.

## Objective
**What:** From a finished agent session, **deploy its app to a live HTTPS URL in one click**, return and
post that URL to the channel, **redeploy on push**, stream deploy status + logs to the channel and web
client, and provide **rollback**, **health-check + auto-restart**, and **one-click scaling** — all through
a swappable `DeployProvider` adapter.

**Why:** Today "agent builds it" stops at a localhost preview (#56). There is no one-click path to a live,
shareable URL with managed HTTPS, monitoring, backups, and scaling. This closes that gap so "agent builds
it → it's live" is one click — the deploy counterpart to #56's run/preview loop.

**Who:** A developer attached to a session (channel **write** capability) who wants that session's app
live. Provider credentials are resolved server-side per tenant; the developer supplies **no** secrets and
**no** command.

### Acceptance criteria (from #73)
1. **A session's app deploys to a live HTTPS URL; the URL is posted to the channel.**
2. **A push redeploys; status/logs are visible.**
3. **Rollback restores a prior good deploy; a failing app auto-restarts/reports.**
4. **Secrets never appear in deploy logs.**
5. Per-tenant isolation + RBAC (#9); secrets via the resolver (never in logs/snapshots); a cloud deploy is
   off-platform egress and is refused under data-privacy mode (#58).
6. `pnpm -C platform typecheck && lint && test && build` green; server integration green.
7. ADR-0041 + this spec + demo `docs/demos/41-deploy-to-live-url.mp4`; PR links #73; **not** merged.

### In scope
- **`DeployProvider` adapter** (`apps/server/src/deploy/provider.ts`) — a narrow interface:
  `deploy(input) → DeployOutcome{ url, providerDeploymentId, status }`, `rollback`, `restart`,
  `scale`, `healthCheck`. Two impls:
  - **`DryRunDeployProvider`** (`deploy/dry-run-provider.ts`) — the **default**. Returns a deterministic
    `https://<slug>.dryrun.reload.app`, records calls, streams a couple of synthetic build lines (one of
    which echoes any injected secret, so the redaction test is real). **Zero cloud spend.**
  - **`VercelDeployProvider`** (`deploy/vercel-provider.ts`) — the real adapter, the SDK behind a **lazy
    `await import`** (optional dependency, never loaded in CI), gated by `DEPLOY_PROVIDER=vercel`; throws a
    helpful install/auth error if the SDK/creds are missing.
  - **`createDeployProvider(env)`** (`deploy/factory.ts`) selects by `env.deploy.provider`, mirroring
    `createRuntime`.
- **Stack detection** (`apps/server/src/deploy/detect.ts`) — a **pure** `detectStack(manifest, files)`
  that infers `{ framework, buildCommand, outputDir }` from `package.json` + a file listing (next / vite /
  cra / astro / static / node), with a config override (`deploy.framework` / `deploy.buildCommand`) taking
  precedence. Pure ⇒ exhaustively unit-tested; no filesystem in the core.
- **`DeployManager`** (`apps/server/src/deploy/manager.ts`) — orchestrates one deploy: `egressAllowed`
  gate → resolve secrets (per workspace) → provision the session's worktree as the build source → detect
  stack → `provider.deploy` with **every log line redacted** → persist the `deployments` row → publish
  `deploy_status`/`deploy_log` → post a `✅ Deployed to <url>` channel message. Also `redeploy` (a new
  immutable deployment), `rollback` (re-promote the prior `ready`), `checkHealth` (→ auto-restart → recover
  or report), `scale` (bounded), `get`/`list`. Injectable deps (provider, loadConfig, secrets, provisioner,
  store, publish, poster, logger) each with a real default — the #33 testability seam. **Persists** (unlike
  run) because a live URL outlives the request.
- **Persistence.** A `deployments` table (`db/schema/deployments.ts`, repo `db/repositories/deployments.ts`,
  migration `apps/server/drizzle/0073_deployer.sql` + `.down.sql`): `id, workspace_id, channel_id,
  session_id, provider, status, url, provider_deployment_id, framework, error, reason,
  rolled_back_from_id, created_by_member_id, created_at`. Each deploy is **immutable** — the row history is
  the backup set. Workspace/channel-scoped reads (IDOR).
- **Realtime.** Two new `ServerEvent` variants on the existing channel bus (no gateway change, like #33/#51):
  `deploy_status` (`queued → building → ready(url) | error(error) | unhealthy | rolled_back`) and
  `deploy_log` (a bounded, **redacted** output chunk). Published via `publishDeployEvent` in `realtime/bus.ts`.
- **REST routes** (`apps/server/src/routes/deploy.ts`), all gated by `requireIdentity` +
  `requireChannelCapability("write")` + channel-scoped `getAgentSession` (IDOR-safe), mirroring `routes/run.ts`:
  - `POST   /channels/:cid/agent-sessions/:id/deploy` — start a deploy (or redeploy; body may carry only a
    bounded `reason`) → `202 { deployment }`.
  - `GET    /channels/:cid/agent-sessions/:id/deploy` — latest deployment `{ status, url?, logs[] }`.
  - `GET    /channels/:cid/agent-sessions/:id/deploy/history` — deployments for the session, newest first.
  - `POST   /channels/:cid/agent-sessions/:id/deploy/rollback` — re-promote the prior `ready` → `202`.
  - `POST   /channels/:cid/agent-sessions/:id/deploy/scale` — bounded `{ instances?, size? }` → `200`.
  Returns `409` when no deploy command/config is set, `409`/`403` under data-privacy mode, `404` cross-channel.
- **Config.** A `deploy` section in the layered schema (`config/schema.ts`) + merge line (`config/layers.ts`):
  `{ provider?, command?, framework?, buildCommand?, outputDir?, env?: string[] (NAMES only),
  maxInstances? }`. **Trusted (repo/managed scope), never request-supplied** — the #33/#27 trust boundary.
  Absent `deploy.command`/config ⇒ `409` (deployment opted out).
- **Env.** `DeployEnv` (`env.ts`): `provider` (`dryrun` default | `vercel`), `monitorIntervalMs` (default
  `0` = the health sweep is off, opt-in like #17/#55 — reserves the periodic sweep; `checkHealth` is the
  implemented per-deployment method, wiring the interval into `index.ts` is a follow-up).
- **Web Deploy tab** (`apps/web`): a `"deploy"` view in `Workspace.tsx` + nav button, a `deploy` store slice
  (mirroring the `run` slice), an `api.deploy` client namespace, the two new events wired into `applyEvent`,
  and a `DeployPanel` that picks a session, hits **Deploy**, shows live status + the live URL (a clickable
  link + open-in-new-tab), streams logs, and offers **Redeploy / Rollback / Scale**.

### Out of scope (deferred / documented-not-automated)
- **Building managed hosting in-house** (VMs, TLS termination, an orchestrator, autoscalers, a backup
  system, on-call) — a VPS business outside "Slack for AI agents" (ADR decision: integrate).
- **A marketplace of self-hosted templates** (n8n/Ghost/WireGuard), managed OS patching, generic VPS/SSH
  hosting — explicitly out of scope per #73; file separately if ever wanted.
- **Auto-triggering a redeploy from the #51 git push event.** The push **seam** is in place
  (`deployManager.deploy(session, { reason: "push", headSha })`); v1 ships the deploy + explicit redeploy
  endpoint and the demo drives the redeploy the same way a push would. Wiring the git hook is a one-line
  follow-up kept off this PR to preserve atomicity (the #33 discipline).
- **Wiring the periodic health sweep** (`DEPLOY_MONITOR_INTERVAL_MS`) into `index.ts` — `checkHealth`
  (auto-restart/report) is implemented + tested; the interval timer that calls it on a schedule is the
  reserved follow-up (the #17/#55 pattern).
- **A second provider adapter** (Railway / Fly / livemy.app), **custom domains**, **preview-per-PR URLs**, a
  **monitoring dashboard/alerting** beyond the opt-in health sweep, and **per-deploy cost accounting**.

## The deploy model
```
DeployStatus = "queued" | "building" | "ready" | "error" | "unhealthy" | "rolled_back"

DeployManager (persisted, keyed by deployment id; per-session history)
  deploy({ sessionId, workspaceId, channelId, createdByMemberId, reason?, headSha? }) -> Deployment
    cfg = loadConfig(workspaceId)
    if !egressAllowed(cfg)            -> throw DeployEgressBlocked (route → 409)
    if !cfg.deploy?.command && provider needs one -> throw NoDeployConfigError (route → 409)
    secrets = secretsResolver.resolve(workspaceId)         // per-tenant
    redact  = makeRedactor(secrets)                        // every log line scrubbed
    cwd     = provisioner.prepare({ sessionId, workspaceId }).cwd   // the agent's worktree (#51/#58)
    stack   = detectStack(cfg.deploy, manifestAt(cwd))             // framework/build/output
    row     = store.create({ ...status: "building", provider, framework, reason })
    publish(deploy_status building);  post nothing yet
    outcome = await provider.deploy({ cwd, env, secrets, stack,
                                      onLog: line => { const r = redact(line);
                                                       store.appendLog(row, r); publish(deploy_log r) } })
    row = store.update(row, outcome.status==="ready"
            ? { status:"ready", url: outcome.url, providerDeploymentId }
            : { status:"error", error: redact(outcome.error) })
    publish(deploy_status …)
    if ready: poster.post(channel, `✅ Deployed to ${outcome.url}`)   // persisted channel message (#5/#8)
    return row
  rollback({ sessionId, … }) -> Deployment            // re-promote prior `ready`; new row, rolled_back_from_id
  checkHealth(deploymentId)  -> Deployment            // healthCheck → restart → recover|unhealthy+report
  scale(deploymentId, { instances?, size? }) -> void  // clamp to cfg.deploy.maxInstances; provider.scale
  get(sessionId)             -> Deployment | null      // latest
  list(sessionId)            -> Deployment[]           // history, newest first
```
**Why a separate manager.** A deploy is neither a harness-to-completion run (`SessionManager`, which
finalizes the session) nor an ephemeral local dev server (`RunProcessManager`). It is a durable one-shot
job whose live URL must survive a restart. Overloading either orchestrator would put a long, off-platform,
credential-bearing job onto a safety-critical path. `DeployManager` keeps the blast radius off them while
reusing the proven provisioner + secrets + redaction primitives — the same discipline #33 used.

## Security
- **Deploy command/config is trusted, never request-supplied.** The build/deploy command, framework, and
  output dir come from resolved layered config (#58, repo/managed scope) — the same trust boundary as the
  #27 harness command and the #56 run command. The request body carries only a bounded `reason` (and, for
  scale, bounded numbers), so a channel writer cannot turn deploy into arbitrary RCE or unbounded scale.
- **Per-tenant secrets, never logged.** Provider credentials live ONLY on the `SecretsResolver` path keyed
  by workspace (config holds env-var *names* only, the #52/#57 convention). Every streamed and persisted
  deploy log line — and any provider error — passes through `makeRedactor(secrets)` (longest-match-first),
  so a secret value can never appear in a `deploy_log` event, the persisted log tail, the `deployments.error`
  column, or the channel message. The secret map itself is never logged. (The #25 guarantee, reused.)
- **Off-platform egress gate.** A cloud deploy sends the agent's built output off-platform, so
  `DeployManager` calls `egressAllowed(cfg)` first and refuses (`409`) when `dataPrivacyMode` is on — the
  same gate the Braintrust exporter and notification webhook honor (#58).
- **IDOR-safe + RBAC.** Every route resolves the session via channel-scoped `getAgentSession(id, cid)` and
  requires **channel write capability**; `deployments` reads are workspace/channel-scoped. A cross-tenant
  session/channel is a `404` (invisible), not a `403`. Deploying, rolling back, and scaling are all writes.
- **Bounded payloads + bounded logs.** `reason` is length-capped; `scale` numbers are range-clamped to
  `cfg.deploy.maxInstances`; the retained log tail is bounded (a chatty build can't grow memory unbounded).

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - **`detectStack`:** next/vite/cra/astro/static/node inferred from `package.json` + files; a config
    `framework`/`buildCommand` override wins; unknown ⇒ a safe `static` default; returns deterministically.
  - **`DeployManager` with a `FakeDeployProvider` + in-memory store** (copy `sandbox-runtime.test.ts`):
    - deploy → `ready` with an `https://…` url; a `✅ Deployed to <url>` message is posted; status/log
      events published.
    - **secret redaction:** a secret value the fake echoes in a build line never appears in any published
      `deploy_log`, the persisted log tail, or a forced provider error — only the mask.
    - **redeploy** creates a **second** immutable deployment (history length grows; ids differ).
    - **rollback** re-promotes the prior `ready` (new row, `rolled_back_from_id` set, status `rolled_back`/
      `ready`).
    - **checkHealth:** a fake reporting unhealthy triggers `restart` then recovers (→ `ready`); a
      still-unhealthy fake → status `unhealthy` + a report message posted.
    - **egress:** `dataPrivacyMode` on ⇒ `deploy` throws `DeployEgressBlocked` (no provider call).
    - **scale:** clamps to `maxInstances`; calls `provider.scale` with the clamped value.
  - **`createDeployProvider`:** `dryrun` (default) → `DryRunDeployProvider`; `vercel` →
    `VercelDeployProvider` (constructed, SDK not loaded — lazy).
- **Integration (real Postgres/Redis, dry-run provider — `pnpm test:integration`, copy `run.test.ts`):**
  `buildApp({ deployManager })` over the dry-run provider. `POST …/deploy` → `202`, poll `GET …/deploy`
  until `ready` with an `https://…` url; assert a `deploy_status ready` event broadcast on the channel and a
  `✅ Deployed to <url>` **message** persisted in the channel. `POST …/deploy` again → a **second** row in
  `…/deploy/history`. `POST …/deploy/rollback` → a `rolled_back`/`ready` row referencing a prior id. A
  secret configured for the workspace **never** appears in any `deploy_log` event or the persisted log tail.
  `409` when no deploy config; `409` under `dataPrivacyMode`; cross-channel access → `404` (IDOR).
- **Web (vitest + jsdom + testing-library — local gate; not in CI's `pnpm test`, per #18/#33/#54):**
  `DeployPanel` shows **Deploy**; after a `deploy_status ready` event it renders the live URL as a link and
  enables **Redeploy/Rollback**; the Deploy nav button switches the `Workspace` view.

## Boundaries
- **Always:** keep deploy off `SessionManager`/`RunProcessManager`; take the deploy command from config
  only; gate every route on channel write + channel-scoped session; resolve secrets per tenant and redact
  every log line + error + channel message; call `egressAllowed` before any provider deploy; make each
  deploy an immutable retained row; default provider = no-spend dry-run with the real Vercel SDK behind a
  lazy import; write the failing test first; attach the demo video.
- **Ask first:** flipping the default provider to `vercel` org-wide; auto-triggering deploys from the git
  push hook; adding a request-body deploy command; a second provider adapter; custom domains.
- **Never:** build in-house managed hosting; accept a deploy command from the request body; let a secret
  reach a log/event/message/error column; deploy under data-privacy mode; let a session be deployed/rolled
  back/scaled across a channel boundary; merge without approval + video.

## Success criteria
1. From a session, one `POST …/deploy` produces a live `https://…` URL that is posted into the channel;
   status + logs stream live (integration + web).
2. A second `POST …/deploy` (redeploy) creates a new immutable deployment; `…/deploy/rollback` re-promotes a
   prior good one (integration).
3. `checkHealth` restarts an unhealthy deploy and recovers, or reports it (unit); scaling is bounded (unit).
4. A workspace secret never appears in any deploy log, event, error, or channel message (unit + integration);
   a deploy under data-privacy mode is refused; cross-channel access denied (integration).
5. `pnpm -C platform typecheck && lint && test && build` green; integration green.
6. ADR-0041 + this spec + demo `docs/demos/41-deploy-to-live-url.mp4`; PR links #73; **not** merged.

## Plan (atomic)
1. **ADR-0041** build-vs-integrate + provider choice — *DEFINE* (this commit).
2. **Provider seam + detection:** `deploy/provider.ts`, `deploy/dry-run-provider.ts`,
   `deploy/vercel-provider.ts` (lazy), `deploy/factory.ts`, pure `deploy/detect.ts` — *slice 1* (test first).
3. **Manager + persistence + config + realtime:** `deploy/manager.ts` (+ `deploy/default.ts`),
   `db/schema/deployments.ts` + repo + migration `0073`, `deploy` config section + merge, `deploy_status`/
   `deploy_log` + `publishDeployEvent`, shared DTO types, `DeployEnv` — *slice 2* (manager test first).
4. **Routes + wiring:** `routes/deploy.ts` (deploy/get/history/rollback/scale) + register in `app.ts` —
   *slice 3* (integration test first).
5. **Web:** `deploy` store slice + `api.deploy` + event wiring + `DeployPanel` + Workspace tab + styles —
   *slice 4* (component tests first).
6. ADR + demo + PR linking #73 — *ship* (not merged).

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR;
> reviewed and merged by @gagan114662 on the video). No merge without approval.
