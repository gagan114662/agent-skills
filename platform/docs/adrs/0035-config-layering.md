# ADR-0035: File-backed Config (TOML) Layering + Managed/Enterprise Settings

- **Status:** Accepted (Gagan approved defaults-and-go — issue #58)
- **Date:** 2026-06-09
- **Context issue:** [#58](https://github.com/gagan114662/agent-skills/issues/58) (Feature phase 4 —
  Real execution & Conductor parity)
- **Builds on:** [ADR-0003](0003-auth-identity.md) (workspace = tenant),
  [ADR-0008](0008-notifications.md) (notification transport seam),
  [ADR-0019](0019-deploy-observability.md) (observability), [ADR-0025](0025-cloud-execution.md)
  (AgentRuntime / SessionManager / AgentJob)

## Context
The platform was **env-var only** (`apps/server/src/env.ts`). That is fine for one operator but does
not match how Conductor — or any real team — configures an agent platform: a developer keeps
**user-scope** preferences, a repo carries **checked-in repo-scope** defaults, and an enterprise admin
sets **managed policy that users cannot weaken** (e.g. "data privacy is ON for this tenant"). Env vars
express none of that: no scoping, no precedence, no lock, no per-tenant policy.

Conductor solved this with file-backed **TOML settings** at user + repo scope (with layering and
migration), a **managed/enterprise settings** layer, an enterprise **data-privacy mode**, and
**files-to-copy** into new workspaces. This ADR adopts the same shape — a layered, file-backed config —
and uses it to deliver two capabilities that need it: **files-to-copy on session create** and the
**data-privacy mode** flag wired through to disable off-platform egress.

## Decisions

1. **Four layers, fixed precedence `env < user < repo < managed`.** `loadConfig(workspaceId?)`
   resolves the layers low→high and the last layer to define a field wins. **Env is the base** (the
   prior env-only behavior is preserved as the lowest layer); **user** then **repo** TOML refine it;
   **managed** is applied last. This deliberately inverts the usual "env overrides files" convention
   because the goal is **enterprise policy**: an admin's managed setting must not be defeated by a
   user's env var or a repo file. Each layer is validated independently.

2. **Managed is the lock; managed may be per-tenant.** Because the managed layer is applied last, a
   managed value **cannot be overridden** by env/user/repo — that is the integrity guarantee. The
   managed file carries a global `[settings]` table plus optional `[workspace.<id>]` tables; for a
   given tenant the managed layer = `merge([settings], [workspace.<id>])`, so a per-tenant managed
   value wins for that tenant only and still beats every lower layer. This mirrors the per-tenant
   shape of the #25 `SecretsResolver` (`*` shared + workspace override).

3. **TOML parsed by `smol-toml`; non-secret settings only; validated by zod.** Config parsing is
   exactly the thing not to hand-roll, so we take one tiny, maintained TOML-1.0 dependency
   (`smol-toml`) rather than a bespoke parser — consistent with the codebase's "don't hand-roll the
   hard, security-sensitive thing" judgement (the same reason the #25 Vercel SDK is a real, isolated
   dependency). The schema (`config/schema.ts`) admits **only** `dataPrivacyMode`, `filesToCopy`,
   `workspaceRoot`; zod strips unknown keys (forward-compatible) and rejects wrong types. **Secrets
   never live in config** — they stay on the #25 `AGENT_SECRETS`/`SecretsResolver` path. The loader
   never reads or writes any secret-bearing variable; a secret-looking key in a TOML layer is simply
   stripped and can never reach `ResolvedConfig`.

4. **Resilient, hermetic loading.** A **missing** file is an absent layer (no error). A **malformed**
   TOML file degrades to an absent layer — it never crashes boot and never surfaces an error
   containing file contents. A **schema-invalid** file (well-formed TOML, wrong types) throws a
   clear, **content-free** `ConfigValidationError` listing offending field paths only. File reads and
   paths are injectable, so unit tests resolve every precedence/lock case without touching disk.

5. **Files-to-copy via an optional workspace seam — default OFF.** `ResolvedConfig.filesToCopy` +
   `workspaceRoot` drive a `WorkspaceProvisioner`. The default `FileConfigWorkspaceProvisioner`
   creates `workspaceRoot/<sessionId>`, copies each configured file in, and returns it as the
   session's `cwd`; `AgentJob` gained an optional `cwd` and `LocalRuntime` spawns the harness there.
   The provisioner is an **optional** dependency of `SessionManager` — when absent, the harness
   inherits the server cwd exactly as before (#25), so existing sessions and tests are unchanged.
   Copies are **best-effort and contained**: a missing source is skipped (logged), and the
   destination is always the source **basename** inside the session dir, so a configured `../` or
   absolute source can never escape the session workspace.

6. **Data-privacy mode wired through one policy gate.** A single helper `egressAllowed(config)` gates
   the two off-platform egress points. When `dataPrivacyMode` is on, `createBraintrustTracer` returns
   the no-op tracer (no trace export, regardless of `BRAINTRUST_API_KEY`) and `selectTransport`
   returns the no-op notification transport (regardless of a configured webhook URL). Deployment-wide
   egress is gated on the **server-level** config (managed-global, no tenant); per-tenant data-privacy
   policy applies per session via the workspace provisioner's tenant-scoped resolve.

7. **Additive, not a rewrite.** `loadEnv()` is unchanged; this ADR *adds* the file layers and the new
   settings rather than migrating existing env vars into TOML. Migrating the rest of `env.ts` onto the
   layered loader is a documented follow-up.

## Consequences
- A developer, a repo, and an enterprise admin can each configure the platform at their own scope, and
  the admin's managed policy cannot be weakened by a lower layer — proven by unit tests on precedence
  and the managed lock (global + per-tenant).
- Files configured in any layer land in the agent's working dir on launch — proven end-to-end by an
  integration test (real Postgres/Redis + LocalRuntime) whose harness reads the copied file from its
  cwd, plus unit tests on the provisioner.
- Data-privacy mode is a one-line managed setting that disables Braintrust export and the notification
  webhook; no agent task/result/notification leaves the process when it is on.
- The default behavior is unchanged: no config files → defaults (privacy off, no files-to-copy); the
  workspace provisioner and egress gates are no-ops unless configured.
- One small dependency (`smol-toml`) enters the lockfile; it is loaded only by the config loader.

## Security
- **Managed-setting integrity:** managed is applied last and per-tenant beats managed-global; a unit
  test proves a managed value survives conflicting env/user/repo values and that a per-tenant value
  applies to its tenant only.
- **No secret leakage via config:** the schema admits only non-secret keys; the loader never touches
  secret-bearing env or files; a unit test asserts a secret-looking key in a layer never appears in
  `ResolvedConfig`. Secrets remain on the #25 redacted `SecretsResolver` path.
- **Parser hardening:** malformed TOML degrades to an absent layer; errors are content-free.
- **Path containment:** files-to-copy writes only under `workspaceRoot/<sessionId>` using basenames.

## Alternatives considered
- **Hand-rolled TOML subset parser** (the dependency-free instinct, as with the #19 metrics registry):
  rejected — correct TOML parsing (strings, arrays, nested/per-tenant tables, types) is error-prone and
  security-sensitive; a 6 KB maintained lib is the right call. The dependency-free choices in this repo
  were for trivial-to-hand-roll surfaces, not a config format.
- **Env overrides files (conventional precedence):** rejected — it would let a user's env var defeat an
  admin's managed policy, defeating the entire point of a managed layer.
- **JSON/YAML config:** rejected — the issue and Conductor parity specify TOML; TOML's `[table]` syntax
  also expresses the per-tenant managed override cleanly.
- **A settings GUI:** out of scope — deferred to #51/web (the web client will read the same resolved
  config later).

## Follow-ups (deferred)
- Hot-reload / file watching (SIGHUP) — config is resolved at process start + per session launch today.
- Migrate the rest of `env.ts` onto the layered loader (settings ⊃ env).
- Monorepo working-dirs discovery (Conductor's per-package cwd); `workspaceRoot` is configurable today.
- Thread `cwd`/files-to-copy into the SandboxRuntime backend (the seam already carries `cwd`).
- A settings GUI + an `.reload/settings.toml` migration tool (Conductor migrates old settings).
