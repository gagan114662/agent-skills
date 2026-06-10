# Spec: Reload Platform — Cloud + Real-Agent Posture (Guided Setup + Preflight) (Issue #69)

> Implements [#69](https://github.com/gagan114662/agent-skills/issues/69). Feature phase 5 —
> Hardening & scale. Part of EPIC #60.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every
> stage governed by a skill in `skills/`. Builds on [#25](25-cloud-execution.md) (cloud execution:
> `AgentRuntime`/`SandboxRuntime`, `SessionManager`), [#50/#27](27-real-agent-harness.md) (the
> `claude-code` harness), [#52](29-model-providers.md) (env-native provider selection), and
> [#58](35-config-layering.md) (layered config).

## Objective
**What:** Make the **cloud + real-agent** path (`AGENT_RUNTIME=sandbox` + `AGENT_HARNESS=claude-code`)
**easy and safe to turn on** behind a guided setup and a **preflight/doctor** that validates the
execution environment *before any run* — so a deployment never starts a half-broken session that fails
deep inside a Vercel sandbox or a missing `claude` binary. Add **config profiles** (`dev` = local/demo,
`prod` = sandbox/claude-code) so the whole posture flips with one switch, and **keep `local`+`demo` the
default** so CI and a fresh clone need no cloud spend. Record the **default-posture decision** (whether/
when to flip the global default) in the ADR — explicitly **gated on #37** (e2e proof at scale).

**Why:** Conductor productizes its cloud as the **default**. Ours defaults to `local` + the `demo` echo
harness, and cloud + a real agent is opt-in via **raw env vars with no preflight**: a misconfigured
`VERCEL_*` or a missing `claude` binary is only discovered *after* a launch, deep in the runtime, as a
confusing failure (or worse, a partial cloud call). There is no guided "zero → first cloud agent" path.
This issue makes turning the cloud path on a **deliberate, validated, documented** action — the safety
rail that lets us flip the default later (#37) with confidence.

**Who:** Operators enabling cloud for the first time (run the doctor, follow the guide), CI (stays on
`dev`/local/demo with zero config), enterprise admins (a managed profile pins `prod`), and the
`SessionManager`, which refuses to launch a non-default posture that fails preflight.

### Acceptance criteria (from #69)
1. **Preflight fails fast with an actionable, secret-free message** when cloud/auth/harness is
   misconfigured — **no cloud call** is made and **nothing is persisted**.
2. **A profile switches runtime + harness cleanly** (`dev` ↔ `prod`); an explicit `AGENT_RUNTIME` /
   `AGENT_HARNESS` still overrides; **CI stays on `local`/`demo`** (default profile = `dev`).
3. **Docs walk a new user from zero → first cloud agent** (the guided setup + `reload doctor`).
4. **Preflight never logs or returns a secret value** — only variable **names** and pass/warn/fail.
5. **The default posture stays `local`/`demo`**; the decision to flip the global default is **deferred
   to #37** and recorded in ADR-0038.
6. `pnpm -C platform typecheck && lint && test && build` green.
7. ADR-0038 + this spec + a guide + demo script `scripts/demos/38-cloud-default-posture.sh` (the
   runnable proof; recorded video pending); PR links #69;
   **not** merged (Gagan approves on the video).

### In scope
- **Profiles (posture presets) — `runtime/posture.ts`.** A `Profile` = a `{ runtime, harness }` preset.
  Two named profiles: `dev` = `{ local, demo }` (today's default, CI-safe) and
  `prod` = `{ sandbox, claude-code }`. `RELOAD_PROFILE` selects one (default `dev`). The preset supplies
  the **defaults** for runtime/harness; an explicit `AGENT_RUNTIME` / `AGENT_HARNESS` still wins
  (precedence: **explicit env > profile preset > built-in default**). Because the default profile is
  `dev`, `loadEnv()` with no new vars resolves to `local`/`demo` exactly as before — existing tests and
  CI are unchanged. `AgentEnv` gains a `profile` field for reporting.
- **Preflight / doctor — `runtime/preflight.ts`.** A **pure** `preflight(input, deps)` that returns a
  structured `PreflightReport { profile, runtime, harness, ok, checks[] }` where each
  `CheckResult { name, status: "pass"|"warn"|"fail", message, remedy? }`. It never throws and never
  reads a secret **value** — checks read only **presence** (`Boolean(env.X)`) and emit the variable
  **name**. `ok = checks.every(c => c.status !== "fail")`. Checks:
  - **runtime=sandbox →** Vercel auth present (either `VERCEL_OIDC_TOKEN`, or all of
    `VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID`); partial access-token auth lists the missing
    **names** and fails. `@vercel/sandbox` SDK resolvable (injectable; the install remedy on fail).
  - **harness=claude-code →** the `claude` binary (or `CLAUDE_BIN`) is on PATH (injectable; install
    remedy on fail). Claude auth: passes if `ANTHROPIC_API_KEY` is set **or** a cloud provider chain is
    selected (`CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`); otherwise a **warn** (an interactive
    `claude login` on the host is also valid — actionable, not a hard block).
  - **runtime=local / harness=demo →** trivially pass (no external deps), so the default posture always
    passes preflight with no network and no binaries.
  Deps (`binaryAvailable`, `moduleResolvable`) are **injectable** so unit tests need no real binary,
  package, or network. A `PreflightError` carries the report (a content-free one-line summary).
- **Launch gate — `SessionManager`.** An **optional** `preflight?: () => PreflightReport` dep. On
  `launch()`, **before** `store.create` (so nothing persists) and before any runtime call (so **no
  cloud call**), it runs preflight; `!ok` throws `PreflightError`. When the dep is absent (every
  existing unit test) the gate is skipped → behavior unchanged. The production wiring
  (`runtime/default.ts`) binds it to the live env; `dev`/local/demo always passes, so existing
  integration tests are unaffected. The launch route maps `PreflightError` → **412 Precondition
  Failed** with the actionable report.
- **`GET /preflight` route.** Runs preflight against the live host env and returns the report (requires
  identity — posture detail is operational, not public). Backs `reload doctor`.
- **Host-side preflight CLI — `pnpm -C platform --filter @reload/server preflight`.** A tiny `tsx`
  entry that runs `preflight(loadEnv().agent, process.env)`, prints the report, and **exits non-zero**
  on `!ok`. The "validate before you even boot" tool for setup — no server, no token, **no cloud call**.
- **`reload doctor` + `reload setup` CLI commands** (zero-dependency `cli/reload.mjs`): `doctor` GETs
  `/preflight` and pretty-prints ✓/⚠/✗ with remedies, exiting non-zero on `!ok`; `setup` prints the
  guided "zero → first cloud agent" checklist (profile + Vercel + claude) and then runs the doctor.
- **Docs — `docs/guides/cloud-setup.md`.** The guided walkthrough; `.env.example` lines for
  `RELOAD_PROFILE` and the cloud/claude vars; ADR-0038.

### Out of scope (deferred / documented-not-automated)
- **Flipping the global default to `prod`** — explicitly deferred; the default stays `dev`/local/demo
  until **#37** proves the cloud path at scale. ADR-0038 records the decision and its gate.
- **A "live" auth probe** (actually calling Vercel / spending a token to confirm auth *works*) —
  preflight validates **configuration presence + harness availability**, not a round-trip. A real
  round-trip is the `sandbox:smoke` script (#25) and #37's e2e proof, not the fail-fast doctor.
- **A setup GUI / web onboarding** — the web client can surface the report later; this issue ships the
  server function, the route, and the CLI.
- **New secrets on the config path** — never; secrets stay on the #25 `SecretsResolver`/`AGENT_SECRETS`
  path. Profiles and preflight read only non-secret presence.
- **A DB migration** — posture is env/config + tooling; `agent_sessions` already records `runtime`.

## The model
```
Profile = { runtime: RuntimeKind, harness: HarnessKind }
PROFILES = { dev: { local, demo },  prod: { sandbox, "claude-code" } }
DEFAULT_PROFILE = "dev"

loadEnv():
  profile = parseProfile(RELOAD_PROFILE)              // default "dev"
  preset  = PROFILES[profile]
  runtime = parseRuntime( AGENT_RUNTIME ?? preset.runtime )   // explicit env wins
  harness = parseHarnessKind( AGENT_HARNESS ?? preset.harness )
  // → no new vars ⇒ dev ⇒ local/demo ⇒ unchanged

PreflightReport = { profile, runtime, harness, ok, checks: CheckResult[] }
CheckResult     = { name, status: pass|warn|fail, message, remedy? }
ok = checks.every(c => c.status !== "fail")

preflight({ profile, runtime, harness, env }, deps) -> PreflightReport   // pure, never throws, no secret values
SessionManager.launch(): if (deps.preflight) { r = deps.preflight(); if (!r.ok) throw PreflightError(r) }   // before store.create + any runtime call
```

## Security
- **No secret leakage from preflight.** Checks read only `Boolean(env.VAR)` and emit the variable
  **name**, never the value. The report (and `PreflightError.message`) is content-free. A unit test
  seeds secret **values** into the env and asserts none appear in `JSON.stringify(report)`.
- **Fail fast, no cloud call, nothing persisted.** The launch gate runs before `store.create` and
  before any `AgentRuntime`/Vercel call. A unit test injects a failing preflight + a runtime/store that
  throw if touched, and asserts `launch()` rejects with `PreflightError` and neither was called.
- **Safe defaults.** Default profile is `dev` (local/demo) — no cloud, no model spend, no binaries. The
  cloud posture is strictly opt-in and, once opted-in, gated by preflight.
- **Trust boundary unchanged.** Profiles select among **trusted** presets; the harness command stays
  config, never client input (#25/#27). No new injection surface.
- **`@vercel/sandbox` stays optional.** Preflight checks resolvability via an **injectable** probe
  (default a guarded `import.meta.resolve`), so the SDK is not forced into the lockfile and tests never
  load it.

## Testing strategy
- **Unit (hermetic, no DB / no network — `pnpm test`):**
  - **Profiles:** `PROFILES.dev` = local/demo, `PROFILES.prod` = sandbox/claude-code; `parseProfile`
    defaults to `dev` for unset/unknown.
  - **Env wiring:** `loadEnv()` with nothing set → local/demo (unchanged); `RELOAD_PROFILE=prod` →
    sandbox/claude-code; an explicit `AGENT_RUNTIME=local` overrides the `prod` preset (explicit wins);
    `loadEnv().agent.profile` reports the selection.
  - **Preflight (all permutations, injected deps):** local/demo → `ok` with trivial passes; sandbox
    with OIDC → pass; sandbox with full access-token trio → pass; sandbox with a partial trio → `fail`
    naming the missing vars; sandbox with no auth → `fail`; SDK unresolvable → `fail`; claude-code with
    a present binary + API key → pass; missing binary → `fail`; no key but Bedrock/Vertex selected →
    pass; no key and no provider chain → `warn` (still `ok`). `ok` reflects `every !== "fail"`.
  - **Secret-safety:** a report built over an env carrying secret *values* contains none of them.
  - **Launch gate:** failing preflight → `launch()` throws `PreflightError`, `store.create` and the
    runtime are never called; passing (or absent) preflight → launch proceeds (existing behavior).
- **Integration (real Postgres/Redis, LocalRuntime — `pnpm test:integration`):** `GET /preflight`
  returns a `dev`/ok report for an authenticated member; a `buildApp` whose `SessionManager` is wired
  with a failing preflight returns **412** with the report from the launch route and creates **no**
  session row.
- The demo (`scripts/demos/38-cloud-default-posture.sh`, recorded as the PR video) shows: a misconfigured
  `prod` profile caught by `pnpm preflight` (fail, actionable, no cloud call) → the operator fixes the
  config → doctor passes → (with real creds) a cloud agent runs. The cloud-agent leg requires real
  Vercel + claude auth and is the part **Gagan approves on the video**.

## Boundaries
- **Always:** keep the default profile `dev` (local/demo); run preflight before any cloud call and
  before persisting; emit variable **names** only (never values); keep `@vercel/sandbox` optional and
  injectable; let an explicit `AGENT_RUNTIME`/`AGENT_HARNESS` override the profile; write the failing
  test first; attach the demo video.
- **Ask first:** flipping the global default to `prod` (gated on #37); adding a live auth round-trip to
  preflight; moving any secret onto the config/preflight path; turning the launch gate on for the
  `dev`/local path.
- **Never:** log or return a secret value from preflight; make a cloud call or persist a row when
  preflight fails; force `@vercel/sandbox` into the lockfile; merge without approval + video.

## Success criteria
1. Misconfigured cloud/auth fails preflight with an actionable, secret-free message; no cloud call,
   nothing persisted (unit + integration).
2. `prod` profile flips runtime+harness; explicit env overrides; CI stays on local/demo (unit).
3. The guide walks zero → first cloud agent; `reload doctor` / `pnpm preflight` validate it.
4. Preflight returns/logs no secret value (unit).
5. The default posture stays `local`/`demo`; the flip is deferred to #37 and recorded in ADR-0038.
6. `pnpm typecheck && lint && test && build` green.
7. ADR-0038 + this spec + guide + demo script `scripts/demos/38-cloud-default-posture.sh` (the runnable
   proof; recorded video pending); PR links #69; **not**
   merged.

## Plan (atomic)
1. `runtime/posture.ts` (profiles + `parseProfile`) and wire the preset into `env.ts` (`profile` on
   `AgentEnv`; preset as the runtime/harness default) — *slice 1*.
2. `runtime/preflight.ts` — pure checks, injectable deps, `PreflightReport`/`PreflightError`,
   default real deps (`binaryAvailable`, `moduleResolvable`) — *slice 2*.
3. Launch gate in `SessionManager` (optional `preflight` dep) + bind it in `runtime/default.ts`; map
   `PreflightError` → 412 in the launch route — *slice 3*.
4. `GET /preflight` route + register; host-side `preflight` npm script; `reload doctor` + `reload setup`
   — *slice 4*.
5. Tests (unit + integration), `docs/guides/cloud-setup.md`, `.env.example` lines — *with each slice*.
6. ADR-0038 + demo + PR — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR;
> reviewed and merged by @gagan114662 on the video). No merge without approval.
