# ADR-0038: Cloud + Real-Agent Posture — Profiles, Preflight, and the Default-Posture Decision

- **Status:** Accepted (Gagan approved defaults-and-go — issue #69)
- **Date:** 2026-06-09
- **Context issue:** [#69](https://github.com/gagan114662/agent-skills/issues/69) (Feature phase 5 —
  Hardening & scale; part of EPIC #60)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (AgentRuntime / SandboxRuntime / SessionManager),
  [ADR-0027](0027-real-agent-harness.md) (the `claude-code` harness),
  [ADR-0029](0029-model-providers.md) (env-native provider selection),
  [ADR-0035](0035-config-layering.md) (layered config)
- **Gated by:** [#37](https://github.com/gagan114662/agent-skills/issues/37) (e2e proof at scale) — see
  Decision 5.

## Context
Conductor productizes its cloud as the **default**. Ours defaults to `local` execution + the `demo`
echo harness, and the cloud + real-agent path (`AGENT_RUNTIME=sandbox` + `AGENT_HARNESS=claude-code`)
is opt-in through **two raw env vars with no validation**. The consequences:

- **No fail-fast.** A misconfigured `VERCEL_*`, a missing `@vercel/sandbox` SDK, or a missing `claude`
  binary is only discovered *after* a launch — deep inside the runtime, as a confusing failure, or
  after a partial cloud call. There is no "is this even runnable?" check.
- **Two switches, easy to desync.** Turning on cloud means remembering to set both the runtime and the
  harness in lockstep; setting one without the other is a silent half-configuration.
- **No guided path.** There is no documented "zero → first cloud agent" flow, and no operator-facing
  doctor to confirm the environment before trusting it with real work.

This ADR makes the cloud + real-agent path **easy and safe to turn on**: one posture switch, a preflight
that validates the environment before any run, a guided setup, and an explicit decision (deferred) on
whether to flip the global default.

## Decisions

1. **Posture profiles — one switch sets runtime + harness.** A `Profile` is a `{ runtime, harness }`
   preset (`runtime/posture.ts`). `RELOAD_PROFILE` selects one: **`dev` = local + demo** (the default)
   or **`prod` = sandbox + claude-code**. The profile supplies the runtime/harness **defaults**;
   precedence is **explicit env (`AGENT_RUNTIME`/`AGENT_HARNESS`) > profile preset > built-in default**.
   Because the default profile is `dev`, `loadEnv()` with no new vars resolves to local/demo exactly as
   before — this is additive, not a behavior change. `AgentEnv` gains a `profile` field for reporting.

2. **Preflight is pure, total, and secret-free.** `preflight(input, deps)` (`runtime/preflight.ts`)
   returns a structured `PreflightReport { profile, runtime, harness, ok, checks[] }`. It **never
   throws** and makes **no network/cloud call** — it inspects configuration *presence* and, via
   injectable probes, local availability. Every check reads only `Boolean(env.VAR)` and emits the
   variable **name** — never a value — so the whole report and `PreflightError.message` are
   content-free. `ok = checks.every(c => c.status !== "fail")`; a `warn` is informational and does not
   block. The default `local`/`demo` posture has no external checks, so it is trivially `ok` — CI and a
   fresh clone are never gated. Probes (`binaryAvailable`, `moduleResolvable`) are injected so unit
   tests need no real binary, package, or filesystem; the production probes use a PATH scan and a
   guarded `import.meta.resolve` (which keeps `@vercel/sandbox` optional — never loaded, never forced
   into the lockfile).

3. **The launch gate fails fast — before persisting, before any cloud call.** `SessionManager` gains an
   **optional** `preflight?: () => PreflightReport` dep. `launch()` runs it **before** `store.create`
   and before touching the runtime; `!ok` throws a `PreflightError` carrying the report. When the dep is
   absent (every existing unit test) the gate is a no-op, so behavior is unchanged. The production
   wiring (`runtime/default.ts`) binds it to the live env; the launch route maps `PreflightError` →
   **412 Precondition Failed** with the actionable report. A misconfigured `prod` launch therefore makes
   **no cloud call and creates no session row** — proven by unit and integration tests.

4. **Three ways to run the same check, one implementation.** (a) **At launch** — the gate above, the
   strongest "no half-broken session" guarantee, covering every launch site through the single
   `SessionManager` chokepoint. (b) **`GET /preflight`** — runs the live host check for an authenticated
   member (posture detail is operational, not public; still names-only), backing `reload doctor`.
   (c) **`pnpm --filter @reload/server preflight`** — a host-side script that validates before the
   server even boots, the right tool during setup. Plus **`reload setup`** prints the guided checklist
   then runs the doctor. All four call the one pure `preflight()`.

5. **Keep the default `dev`; defer the global-default flip to #37.** The global default **stays
   `local`/`demo`** in this change. Flipping the productized default to `prod` is **deliberately
   deferred** until #37 proves the cloud path end-to-end at scale: a default that spends cloud + model
   budget on every fresh clone and CI run must be earned by evidence, not assumed. This issue builds the
   safety rail (profiles + preflight + guided setup) that *lets* us flip the default later with
   confidence; the flip itself is a one-line change to `DEFAULT_PROFILE` once #37 is green, and will be
   its own reviewed PR.

6. **No new secret surface, no migration.** Profiles select among **trusted** presets and preflight
   reads only non-secret presence — secrets stay on the #25 `SecretsResolver`/`AGENT_SECRETS` path. The
   harness command remains config, never client input (#25/#27), so there is no new injection surface.
   Posture is env/config + tooling; `agent_sessions` already records `runtime`, so there is **no DB
   migration**.

## Consequences
- Turning on cloud + a real agent is **one switch** (`RELOAD_PROFILE=prod`) plus a **green preflight**,
  with a documented zero → first-cloud-agent guide.
- A misconfigured cloud/auth/harness **fails fast** with an actionable, secret-free message — at setup
  (`pnpm preflight`), at the server (`reload doctor` / `GET /preflight`), and at launch (412), **never
  making a cloud call or persisting a row** when it can't run.
- CI and a fresh clone are **unchanged**: default profile `dev` → local/demo → preflight trivially `ok`,
  the launch gate a no-op for that path. All 375 unit + 132 integration tests stay green.
- `@vercel/sandbox` stays **optional** — preflight detects its presence without importing it.
- The platform is now **ready to flip the default to `prod`** the moment #37 proves it at scale — a
  one-line change, not a re-architecture.

## Security
- **No secret leakage from preflight:** checks read only `Boolean(env.VAR)` and emit variable names; a
  unit test seeds secret *values* into the env and asserts none appear in the serialized report.
- **Fail-fast safety:** the launch gate runs before persistence and before any runtime/cloud call; a
  unit test injects a failing preflight + a store/runtime that throw if touched and asserts neither is
  called, and an integration test asserts the 412 launch creates no session row.
- **Safe defaults:** default profile `dev` (local/demo) — no cloud, no model spend, no binaries; the
  cloud posture is strictly opt-in and, once opted-in, gated by preflight.
- **Trust boundary unchanged:** profiles pick among trusted presets; the harness command stays config,
  never client input.

## Alternatives considered
- **Live auth round-trip in preflight** (actually call Vercel / spend a token to confirm auth *works*):
  rejected for the fail-fast doctor — it would cost money/latency and could itself fail for unrelated
  reasons. Preflight validates **configuration presence + local availability**; a real round-trip is the
  `sandbox:smoke` script (#25) and #37's e2e proof.
- **Flip the global default to `prod` now:** rejected — a default that spends cloud + model budget on
  every clone/CI run must be earned by #37's scale proof first. Deferred (Decision 5).
- **Gate only at the REST route (not the SessionManager):** rejected — multiple launch sites (git-review
  follow-ups, integrations issue→session, autonomy, team) would each need their own gate. The single
  `SessionManager` chokepoint covers them all.
- **A `claude login` hard-fail when no `ANTHROPIC_API_KEY`:** rejected — an interactive host login is a
  valid auth path we can't confirm without spending, so it is a non-blocking `warn`, not a `fail`.
- **Make `@vercel/sandbox` a hard dependency to simplify the check:** rejected — it stays optional
  (#25); preflight probes resolvability via `import.meta.resolve` without importing it.

## Follow-ups (deferred)
- **#37:** prove the cloud + real-agent path end-to-end at scale; then flip `DEFAULT_PROFILE` to `prod`
  in a dedicated PR (Decision 5).
- Thread the posture/preflight report into the web client onboarding (a setup UI).
- An optional opt-in "live" auth probe (`reload doctor --deep`) that does a real, budgeted round-trip.
- Per-tenant managed profiles (a managed-layer `profile` key) once a deployment runs mixed postures.
