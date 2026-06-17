# ADR-0292: Deploy version-advance verification — prove the running release is the one we shipped

- **Status:** Accepted (shipped in PR for #292)
- **Date:** 2026-06-17
- **Context issue:** [#292](https://github.com/gagan114662/agent-skills/issues/292) — PROD BLOCKER:
  `reload-api` was stuck on VERSION 80 while CI was green, so the merged [#247](https://github.com/gagan114662/agent-skills/issues/247)
  model fix never reached prod and the live ipop.ai console kept throwing *"the model this workspace is
  set to use isn't available — exit 1"*. The #1 blocker to revenue: the fleet could not run in prod.
- **Builds on:** [ADR-0138](0138-pop-identity-channels-deploy.md) (the `fly-deploy.yml` CI deploy of the
  API), the Fly `[deploy] release_command` gate (#273, `runtime/release-cli.ts`) and the preflight + smoke
  posture gates (#238, `runtime/preflight.ts`), the `claude-opus-4-8` fleet model + #246 launch preflight
  (#246/#242) whose fix this unsticks, and [ADR-0200](0200-premortem-panel.md) (the standing premortem —
  FM#2 verification that never touches reality, FM#4 irreversibility, FM#6 prompt/data injection).

## Context

The deploy pipeline (#273) already does the hard parts well: the Fly `release_command` runs migrate →
preflight → smoke on a one-off VM **before** traffic shifts, and `fly-deploy.yml` waits for `/readyz` to
go green after the rolling rollout. But it had one blind spot that turned into the #292 prod blocker:

**nothing verified that the running image actually *changed*.** Every post-deploy check was a *liveness*
check — `/readyz` proves Postgres + Redis are reachable, which the **old** release passes just as well as
a new one. So any path where a deploy silently no-ops left prod stuck on the previous image with **CI
green**:

- the `paths:` filter on `fly-deploy.yml` not matching a merge,
- the "skip cleanly when `FLY_API_TOKEN` is unset" guard turning the whole job green without deploying,
- a `flyctl deploy` that didn't cut over (image unchanged, or a rollout that aborted upstream).

Live proof of the failure signature, captured 2026-06-17 against prod:

```
$ curl https://reload-api.fly.dev/readyz   → {"status":"ready","db":"up","redis":"up"}   # old image is HEALTHY
$ curl https://reload-api.fly.dev/version  → HTTP 404 Route GET:/version not found        # …but it's the OLD build
```

`/readyz` green + the running image predating this very route is exactly the "stuck on v80 while CI is
green" trap. This is premortem **FM#2** in the deploy layer: *verification that never touches reality* —
the deploy reported success without a receipt that the new build is the one actually serving traffic.

## Decision

Add a **version-advance receipt** to the deploy: stamp the build's git SHA into the image, expose it on a
new probe, and after a deploy assert the **live** host reports the commit we just shipped. Fail closed and
red on any mismatch — a deploy that doesn't advance the running version can never again read as success.

### The pieces (all additive; no migration, no new table)

| Piece | Where | What |
|---|---|---|
| Build stamp | `apps/server/Dockerfile` | `ARG GIT_SHA` → `ENV GIT_SHA` in the runtime stage. CI passes `--build-arg GIT_SHA=${{ github.sha }}`. Defaults to `""` for local/dev. Reuses the existing `GIT_SHA` env convention (`evals/default.ts`). |
| Probe | `routes/health.ts` `GET /version` + `VersionResponse` in `@reload/shared` | Returns `{ version: process.env.GIT_SHA ?? GITHUB_SHA ?? "" }`, read at request time so it reflects the running image. Unauthenticated like the other probes (no tenant data). |
| Pure decision | `runtime/release-verify.ts` | `normalizeSha` (untrusted-input guard) + `decideReleaseAdvanced` (fail-closed verdict). No IO. |
| Verify CLI | `runtime/verify-release-cli.ts` (`pnpm … verify:release`) | Injectable `verifyReleaseLive` (probe + retry) + real `fetchLiveVersion`. Exits non-zero on no-advance. |
| CI gate | `.github/workflows/fly-deploy.yml` | New "Verify release advanced" step probes the live `/version` and asserts it equals `${{ github.sha }}`, failing the job red on a stuck deploy. |

### Premortem (#200) discipline

- **Production-grounded verification (FM#2).** The receipt is the **live** host queried over the network
  after the rollout, never local build state. `decideReleaseAdvanced` is **fail-closed**: a missing
  expected SHA, a missing/`""` live SHA (the un-stamped old image), an unreachable host, or a malformed
  body all return `advanced: false` — it never fabricates a pass.
- **Injection defense (FM#6).** The `/version` body is untrusted data fetched over the network.
  `normalizeSha` accepts only a bounded `[0-9a-f]{7,64}` hex string (trimmed, lower-cased); anything else
  (an HTML error page, attacker JSON, an oversized blob) normalizes to `null` and fails the gate closed.
  A reported value is never interpreted, shell-expanded, or trusted beyond a prefix/equality comparison.
- **Irreversible action stays human/CI-gated (FM#4).** The actual `flyctl deploy` remains an
  owner/CI-triggered action — this change adds no new authority to mutate prod. The CLI's failure message
  pre-commits the remediation runbook ("capture the current release as a rollback target, then re-run the
  deploy, then re-verify"), so the recovery is decided in advance, not improvised under an outage.
- **No migration / no new table.** Pure reuse of the existing health route + env convention → zero
  sibling-workspace migration-collision risk, colocation stays green.

## Consequences

- The #292 remediation can now be executed and *proven*: ship current `main` (the deploy passes
  `--build-arg GIT_SHA`), and the "Verify release advanced" step confirms the running release is the new
  commit — or fails red, surfacing the stuck deploy instead of hiding it behind a green check. Once live,
  `GET /version` is the standing, scriptable answer to "what is prod actually running right now?".
- The version-advance gate complements (does not replace) the #273 release_command and the `/readyz`
  health gate: those prove the new image is *safe to serve*; this proves it is *the one being served*.
- `/readyz` is deliberately left dependency-only (a load balancer's traffic gate must not depend on a
  build stamp); the version receipt is its own `/version` route so the two concerns stay separable.
- Honest "unknown": an un-stamped image (local, or any build without the arg) reports `version: ""`, which
  the decider treats as **unknown → not advanced**, never as a silent match.
