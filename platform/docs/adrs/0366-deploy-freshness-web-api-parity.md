# ADR-0366: Deploy freshness — ipop.ai web serves current `main`, and web↔API versions are made to match

- **Status:** Accepted (shipped in PR for #366)
- **Date:** 2026-06-18
- **Context issue:** [#366](https://github.com/gagan114662/agent-skills/issues/366) — sub-issue (6) of
  epic [#359](https://github.com/gagan114662/agent-skills/issues/359) ("make the reload.chat vision real on
  ipop.ai"). The owner can only *watch agents coordinate* if the Vercel-hosted web at `https://ipop.ai`
  actually serves current `main` — including the re-mounted coordination view ([#354](https://github.com/gagan114662/agent-skills/issues/354))
  — and is on a build that matches the healthy `api.ipop.ai`. Stale prod is documented history, not a
  hypothetical: [#292](https://github.com/gagan114662/agent-skills/issues/292) (`reload-api` stuck on v80
  while CI was green) and [#293](https://github.com/gagan114662/agent-skills/issues/293) (a migration that
  never reached live rows).
- **Builds on:** [ADR-0292](0292-release-version-verification.md) (the API build-stamp `GIT_SHA` →
  `GET /version` + the `decideReleaseAdvanced` post-deploy gate — this ADR is its **front-end half**),
  [ADR-0352](0352-agent-coordination-surface.md) (the coordination view + the default-OFF owner-first web
  flag pattern this reuses), [#365](https://github.com/gagan114662/agent-skills/issues/365) (`connect-health-flag.ts`,
  the same gate shape), `platform/vercel.json` (the Vercel web build), `platform/fly.toml` /
  `.github/workflows/fly-deploy.yml` (the API deploy), and [ADR-0200](0200-premortem-panel.md) (FM#2
  verification that never touches reality, FM#6 untrusted network data).

## Context

#292 closed the **API** half of deploy freshness: the running image is stamped with its commit SHA, served
at `GET /version`, and a post-deploy CI gate probes the **live** host and fails red unless it reports the
commit just shipped. That makes a stuck `api.ipop.ai` detectable.

It left two gaps that #366 closes for the epic:

1. **The web side had no stamp.** Vercel auto-deploys `main` on every push, but nothing recorded *which*
   commit a given `https://ipop.ai` bundle was built from, and nothing compared it to the API. A stale
   bundle (a no-op'd Vercel build, a preview URL confused for prod, an aggressively-cached asset) against a
   newer API — or vice-versa — was **silent**. The owner would see a board that lags the code with no
   signal that anything is wrong: exactly the #292 failure mode, one layer up.
2. **The two halves were never reconciled.** "Web serves current `main`" and "API is on current `main`" are
   two facts; the epic needs them to be *the same* fact, and a divergence to be caught by a check before it
   reaches the owner.

`/readyz` cannot help here (it is dependency reachability, and is API-only). This is premortem **FM#2** in
the front-end deploy layer: success was being assumed without a receipt that the served bundle is the
current one.

## Decision

Stamp the **web** build with its git SHA the same way #292 stamps the API, and add a **pure, fail-closed
web↔API parity check** that surfaces a *confirmed* divergence to the owner — reusing #292's SHA discipline
exactly so there is one source of truth for "are these the same build?". Default-OFF and owner-workspace-first
(epic rail): prod with no env set is **byte-for-byte the board it is today**.

### The pieces (all additive; no migration, no new table, no new backend)

| Piece | Where | What |
|---|---|---|
| Web build stamp | `platform/vercel.json` | `buildCommand` maps Vercel's `VERCEL_GIT_COMMIT_SHA` → `VITE_RELOAD_BUILD_SHA`, which Vite statically inlines. Empty (`${VERCEL_GIT_COMMIT_SHA:-}`) for non-git/local builds ⇒ "unknown" parity, never a false match. |
| Pure gate + verdict | `apps/web/src/components/console/version-check.ts` | `shouldShowVersionCheck` (default-OFF, owner-first, fail-closed — identical to coordination/connect-health), `normalizeSha` (the #292 `[0-9a-f]{7,64}` guard), and `decideVersionParity` → `match` / `mismatch` / `unknown`. |
| API probe client | `apps/web/src/api/client.ts` `getVersion()` + `/version` in the Vite dev proxy | Reads the API's `GET /version` (#292) — unauthenticated, tenant-agnostic. |
| Banner | `apps/web/src/components/console/VersionMismatchBanner.tsx` + `ConsoleView.tsx` | Presentational; renders ONLY on a confirmed `mismatch`. Fetches `/version` once (a deploy mismatch is steady-state, not a blip — no polling), compares to `WEB_BUILD_SHA`, shows the two short SHAs + a reload control. |
| Deploy runbook | `platform/docs/guides/ipop-deploy.md` | Documents the Vercel + Fly deploy of current `main` and the manual/CI step that captures the live `https://ipop.ai` build SHA and `api.ipop.ai` `/version` and asserts they correspond (acceptance #3). |

### Premortem (#200) discipline

- **Production-grounded, fail-quiet verification (FM#2).** `decideVersionParity` raises a `mismatch` **only**
  when it holds two valid, genuinely-divergent SHAs. A missing/unstamped/garbage SHA on **either** side
  (a local build, an unreachable or old/unstamped API, a `/version` that returned an HTML error page) →
  `unknown` → the banner stays **silent**. We never fabricate a freshness claim, and we never false-alarm.
- **Injection defense (FM#6).** The API `/version` body is untrusted network data. `normalizeSha` accepts
  only a bounded, trimmed, lower-cased hex string (mirroring #292's `release-verify.ts`); anything else
  normalizes to `null`. The two SHAs are rendered only as 7-char hex slices — never interpreted as markup.
- **No behaviour change by default (epic rail).** The surface is gated `VITE_RELOAD_VERSION_CHECK_UI` +
  owner-workspace-id, both unset in prod ⇒ the effect never fires and the banner never mounts. Customer
  tenants are unaffected. No prod flag is flipped by this PR; enabling it for the owner workspace is the
  owner-gated operational follow-up (per ADR-0352 §2).
- **Reversible, build + PR only.** No migration, no table, no new action — and nothing irreversible: a real
  mismatch is fixed by a Vercel redeploy/rollback, which the banner simply makes visible. The #13 approval
  queue is untouched.

## Consequences

- The epic's stale-board risk becomes **detectable, not silent**: with the owner flag on, a divergence
  between the served bundle and the running API raises a banner instead of quietly showing a board behind
  the code. The coordination view (#354) shipping in the bundle is verifiable the same way the API's commit
  is — both reduce to a SHA comparison.
- `WEB_BUILD_SHA` (inlined) + `GET /version` (API) are now the two scriptable answers to "what is each side
  of ipop.ai actually running right now?", which the deploy runbook uses for the acceptance assertion.
- The check is deliberately **fail-quiet**: an unstamped local/dev build is `unknown` and shows nothing, so
  developers never see a spurious banner, and a transient API blip leaves the prior (silent) state.
- This is the front-end complement to #292 — together they cover both halves of "ipop.ai is on current
  `main`". It adds no real-time/coordination capability itself; that is sub-issues (1) and (2).
