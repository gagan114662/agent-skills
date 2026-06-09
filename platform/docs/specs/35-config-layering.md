# Spec: Reload Platform — File-backed Config (TOML) Layering + Managed/Enterprise Settings (Issue #58)

> Implements [#58](https://github.com/gagan114662/agent-skills/issues/58). Feature phase 4 — Real
> execution & Conductor parity.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every
> stage governed by a skill in `skills/`. Builds on [#25](25-cloud-execution.md) (cloud execution:
> `AgentRuntime`, `SessionManager`, the per-session job/`AgentJob` seam).

## Objective
**What:** Give Reload **file-backed, layered configuration** — TOML settings at **repo** and **user**
scope on top of the existing **env** base, plus a **managed/enterprise** override layer that lower
layers **cannot** override (optionally **per-tenant**). On top of the config model, deliver two
Conductor-parity capabilities that need it: **files-to-copy into a new session workspace**, and an
**enterprise data-privacy mode** flag that is wired through to disable off-platform data egress.

**Why:** Today the platform is **env-var only** (`apps/server/src/env.ts`). That is fine for a single
operator but does not match how Conductor (and real teams) configure agent platforms: a developer
keeps **user-scope** preferences, a repo carries **checked-in repo-scope** defaults, and an
enterprise admin sets **managed policy that users cannot weaken** (e.g. "data privacy is ON for this
tenant"). Env vars cannot express that precedence or that lock. A layered, file-backed config is the
hard dependency for managed settings, data-privacy mode, and workspace provisioning.

**Who:** Developers (user-scope TOML), teams (repo-scope TOML checked in), enterprise admins (managed
TOML — possibly per-tenant), and the `SessionManager`, which consumes the resolved config to
provision each session's workspace and to decide whether external egress is allowed.

### Acceptance criteria (from #58)
1. A layered loader resolves precedence **env < user < repo < managed** (managed wins) with schema
   validation.
2. A value set in the **managed** layer **cannot be overridden** by a lower layer; managed settings
   may be **per-tenant** (keyed by workspace) and the per-tenant managed value wins for that tenant.
3. **Files-to-copy** configured in the layered config **land in a new session workspace** on launch.
4. A **data-privacy mode** flag (settable via managed, per-tenant) is **wired through** so that when
   on, off-platform data egress (Braintrust trace export, the notification webhook) is disabled.
5. **No secret leakage via config:** config files carry **non-secret settings only**; secrets stay on
   the existing `AGENT_SECRETS`/`SecretsResolver` path (#25) and are never read from or written by the
   config loader.
6. `pnpm -C platform typecheck && lint && test && build` green.
7. ADR-0035 + spec + demo `docs/demos/35-config-layering.mp4`; PR links #58; **not** merged.

### In scope
- **A `config/` module** in `apps/server/src/config/`:
  - `schema.ts` — a **zod** schema for the file-backed settings (every field optional, so a *layer* is
    a partial), plus a `ResolvedConfig` shape with defaults. Unknown keys are stripped (forward-compat),
    type-invalid values are rejected with a clear error.
  - `layers.ts` — a pure **deep-merge in precedence order** (`defaults → env → user → repo → managed`),
    last-defined wins, so the managed layer (applied last) is the lock.
  - `loader.ts` — reads the three TOML files (user/repo/managed) + an env-derived layer, validates each,
    and produces a `ResolvedConfig` **for a given workspace** (so the per-tenant managed override
    applies). File reads + paths are **injectable** so unit tests never touch real disk; missing files
    are simply absent layers (no error).
- **TOML format** (parsed with `smol-toml`, a tiny TOML-1.0 lib — config parsing is exactly the thing
  not to hand-roll):
  - User/repo `settings.toml` are **flat** key/values.
  - Managed `managed.toml` has a global `[settings]` table plus optional `[workspace.<id>]` tables;
    managed-for-tenant = `merge([settings], [workspace.<id>])` and that is the top layer.
- **Files-to-copy on session create** — `ResolvedConfig.filesToCopy: string[]` + `workspaceRoot`.
  A `WorkspaceProvisioner` seam materializes a per-session working dir under `workspaceRoot/<sessionId>`
  and copies the configured files into it. `AgentJob` gains an optional `cwd`; `LocalRuntime` spawns the
  harness in that `cwd`. The provisioner is an **optional** dependency of `SessionManager` (default
  none → today's behavior), so existing sessions/tests are unchanged.
- **Data-privacy mode wired through** — `ResolvedConfig.dataPrivacyMode: boolean`. A single policy
  helper `egressAllowed(config)` gates the two off-platform egress points: the **Braintrust tracer**
  (returns the no-op tracer when privacy is on) and the **notification webhook transport** (returns the
  no-op transport when privacy is on). Server-level egress is gated on the **server config**
  (managed-global, no tenant).
- **Examples + docs** — a committed `.reload/settings.toml.example`, a `managed.toml.example`, and new
  `.env.example` lines documenting the env-layer keys and the managed config path.

### Out of scope (deferred / documented-not-automated)
- **A settings GUI** — follow-up under #51/web (the web client reads the same resolved config later).
- **Hot-reload / file watching** — config is resolved at process start (server-level) and at session
  launch (per-tenant); a SIGHUP/watch reloader is a follow-up.
- **Monorepo working-dirs discovery** (Conductor's per-package cwd) — `workspaceRoot` is configurable;
  auto-detecting sub-package dirs is deferred.
- **Migrating existing env vars into TOML** — the env layer remains the base and `loadEnv()` is
  unchanged; this issue *adds* the file layers and the new settings, it does not rewrite `env.ts`.
- **Secrets in config** — explicitly never; secrets stay on the `#25` `SecretsResolver` path.

## The config model
```
ResolvedConfig            // resolved, defaults applied
  dataPrivacyMode: boolean   // default false
  filesToCopy: string[]      // default []
  workspaceRoot: string      // default ".reload/workspaces"

Settings = Partial<ResolvedConfig>   // one layer (zod-validated, all keys optional)

loadConfig(workspaceId?, sources?) -> ResolvedConfig
  layers, low → high precedence:
    1. defaults
    2. env       (RELOAD_DATA_PRIVACY_MODE, RELOAD_FILES_TO_COPY, RELOAD_WORKSPACE_ROOT)
    3. user      (~/.reload/settings.toml          — RELOAD_USER_CONFIG overrides path)
    4. repo      (<repoRoot>/.reload/settings.toml  — RELOAD_REPO_CONFIG overrides path)
    5. managed   ([settings] then [workspace.<workspaceId>] from managed.toml
                  — RELOAD_MANAGED_CONFIG overrides path)
  merge = last-defined-wins per field  ⇒ managed is the lock; per-tenant managed beats managed-global
```
**Precedence rationale (env is the *base*, managed is the *lock*).** This deliberately inverts the
"env overrides files" convention because the goal is **enterprise policy**: an admin's managed setting
must not be defeated by a user's env var or a repo file. Env is the lowest layer (the old default),
files refine it, and managed is final.

## TOML formats
**User / repo — `.reload/settings.toml` (flat):**
```toml
dataPrivacyMode = false
filesToCopy = ["AGENTS.md", "docs/agent-context.md"]
workspaceRoot = ".reload/workspaces"
```
**Managed / enterprise — `managed.toml` (global + per-tenant):**
```toml
[settings]                 # applies to every tenant, locked vs user/repo/env
dataPrivacyMode = true

[workspace.ws_acme]        # per-tenant managed override (still locked, beats [settings])
dataPrivacyMode = false
filesToCopy = ["compliance/NOTICE.md"]
```

## Files-to-copy & the workspace seam
```
WorkspaceProvisioner.prepare({ sessionId, workspaceId }) -> { cwd?: string }
  FileConfigWorkspaceProvisioner:
    cfg = loadConfig(workspaceId)
    dir = join(cfg.workspaceRoot, sessionId);  mkdir -p dir
    for f in cfg.filesToCopy: copy f -> join(dir, basename(f))   // skip missing source, never throw
    return { cwd: dir }
```
- `AgentJob` gains `cwd?: string`. In `SessionManager.runSession`, when a provisioner is configured it
  is called **before** `runtime.start`, and the returned `cwd` is put on the job.
- `LocalRuntime.start` passes `cwd: job.cwd` to `spawn` (undefined → inherits server cwd, today's
  behavior). The sandbox backend receives `cwd` through the same job; copying into a sandbox is a
  documented follow-up (the seam carries it).
- Copy is **best-effort and path-guarded**: a missing source file is skipped (logged), never fatal; the
  copy is confined to the session dir.

## Data-privacy wiring
```
egressAllowed(cfg) = !cfg.dataPrivacyMode

createBraintrustTracer(cfg?)  -> noopTracer when !egressAllowed(cfg)   (else today's behavior)
selectTransport(webhookUrl, cfg?) -> NoopTransport when !egressAllowed(cfg)  (else webhook/no-op)
```
When data-privacy mode is on for the deployment (managed-global) the server constructs the no-op
tracer and no-op notification transport regardless of `BRAINTRUST_API_KEY` / `NOTIFY_WEBHOOK_URL`, so
no agent task, result, or notification leaves the process.

## Security
- **No secret leakage via config (loader integrity).** The config schema admits **only** non-secret
  settings; the loader never reads `AGENT_SECRETS`, `*_API_KEY`, `DATABASE_URL`, etc., and never writes
  config values anywhere secret-bearing. Secrets remain on the #25 `SecretsResolver` path and continue
  to be redacted from output. A test asserts a secret-looking key in a TOML layer does not appear in
  `ResolvedConfig`.
- **Managed-setting integrity.** Managed is applied last and per-tenant managed beats managed-global; a
  unit test proves a managed value survives a conflicting user/repo/env value (the lock) and that a
  per-tenant managed value wins for its tenant only.
- **Parser hardening.** `smol-toml` is a maintained TOML-1.0 parser; a malformed file is caught and
  treated as an **absent layer** (the deployment degrades to lower layers) rather than crashing boot or
  leaking a parse error containing file contents.
- **Path containment.** Files-to-copy writes only under `workspaceRoot/<sessionId>`; basenames are used
  for the destination so a configured `../` source cannot escape the session dir.

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - **Precedence:** with all four layers setting the same field, the resolved value follows
    `env < user < repo < managed`; lower layers fill fields the higher ones omit.
  - **Managed lock:** a managed value is **not** overridden by user/repo/env; a `[workspace.<id>]`
    managed value wins for that tenant and not for others.
  - **Validation:** a type-invalid value (e.g. `dataPrivacyMode = "yes"`) is rejected with a clear
    error; unknown keys are stripped; a malformed TOML file degrades to an absent layer.
  - **No secret leakage:** a secret-looking key in a layer never appears in `ResolvedConfig`.
  - **Files-to-copy:** `FileConfigWorkspaceProvisioner.prepare` creates `workspaceRoot/<sessionId>` and
    copies the configured files into it (real temp dir); a missing source is skipped, not fatal.
  - **Data-privacy wiring:** `egressAllowed` is false under privacy mode; `createBraintrustTracer(cfg)`
    returns the no-op tracer and `selectTransport(url, cfg)` returns `NoopTransport` when privacy is on.
  - **SessionManager seam:** with a fake provisioner, `runSession` sets `AgentJob.cwd` from
    `prepare()`; with no provisioner, `cwd` stays undefined (today's behavior — existing tests stay
    green).
- **Integration (real Postgres/Redis, LocalRuntime — `pnpm test:integration`):** launch a session with
  a repo-scope `filesToCopy` configured against a temp `workspaceRoot`; assert the session's working dir
  exists and contains the copied file, and the session still reaches `completed`.
- The demo (`scripts/demos/35-config-layering.sh`, recorded as the PR video) shows the three layers
  resolving, a managed override winning over a repo setting, files-to-copy landing in a session
  workspace, and data-privacy mode disabling egress.

## Boundaries
- **Always:** keep env as the base and managed as the lock; validate every layer; treat a malformed/
  missing file as an absent layer; keep secrets off the config path; copy files only under the session
  dir; default the workspace provisioner OFF so existing behavior is unchanged; write the failing test
  first; attach the demo video.
- **Ask first:** changing the precedence order; moving any secret onto the config path; turning the
  workspace provisioner on by default for all deployments; auto-detecting monorepo working dirs.
- **Never:** let a lower layer override a managed setting; read or persist secrets via config; let a
  configured `../` source escape the session workspace; crash boot on a malformed config file; merge
  without approval + video.

## Success criteria
1. `loadConfig` resolves `env < user < repo < managed` with validation; managed cannot be overridden;
   per-tenant managed wins for its tenant (unit tests).
2. Files-to-copy land in a new session workspace (unit + integration).
3. Data-privacy mode disables Braintrust export and the notification webhook (unit tests).
4. No secret is readable from or written by the config loader (unit test).
5. `pnpm typecheck && lint && test && build` green; integration green.
6. ADR-0035 + this spec + demo `docs/demos/35-config-layering.mp4`; PR links #58; **not** merged.

## Plan (atomic)
1. `config/schema.ts` (+ defaults) and `config/layers.ts` (deep-merge precedence) — *slice 1*.
2. `config/loader.ts` — TOML reads (injectable), env layer, per-tenant managed, validation — *slice 1*.
3. `config/workspace.ts` — `WorkspaceProvisioner` + `FileConfigWorkspaceProvisioner` (files-to-copy);
   `AgentJob.cwd`; `LocalRuntime` cwd; optional `SessionManager` seam — *slice 2*.
4. Data-privacy: `egressAllowed`; gate `createBraintrustTracer` + `selectTransport`; wire in
   `runtime/default.ts` / notify wiring — *slice 3*.
5. Tests (unit + integration), `.reload/*.example`, `.env.example` lines — *with each slice*.
6. ADR-0035 + demo + PR — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR;
> reviewed and merged by @gagan114662 on the video). No merge without approval.
