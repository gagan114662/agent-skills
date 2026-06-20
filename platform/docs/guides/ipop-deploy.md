# Deploying ipop.ai — web (Vercel) + API (Fly), and keeping them on the same build

ipop.ai is a **split deployment** (#108):

- **Web** — the React console (`@reload/web`), built by Vercel and served at `https://ipop.ai`.
- **API** — the Fastify server (`@reload/server`, app `reload-api`), deployed to Fly and served at
  `https://api.ipop.ai`. See `platform/fly.toml` and `.github/workflows/fly-deploy.yml`.

The web talks to the API cross-origin; the browser sends the httpOnly `rid` session cookie because the
server sets it `SameSite=None; Secure` and allow-lists `https://ipop.ai` for credentialed CORS
(`RELOAD_WEB_ORIGIN` in `fly.toml`). The cookie attributes are decided by `resolveSessionCookieOptions`
(`apps/server/src/routes/auth.ts`, #418): when `RELOAD_WEB_ORIGIN` names a separate web origin the cookie
goes `SameSite=None; Secure` (cross-site); otherwise it stays `SameSite=Lax` so it still sets over plain
http in local same-origin dev. A `Lax` cookie is **silently dropped** on the SPA's cross-site `fetch`, so
before #418 `bootstrap()` GET /me 401'd and AuthGate redirected to `/start`.

### Automated login for headless QA (#418)

To dogfood the **authenticated** app headlessly (not just public pages), log in programmatically and
reuse the cookie jar — the `SameSite=None; Secure` cookie now attaches on cross-site fetch:

```sh
# 1. Log in (stores the rid cookie in a jar). Use a synthetic QA account, never a real customer.
curl -sS -c /tmp/ipop-qa.cookies -X POST https://api.ipop.ai/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"<qa-account>","password":"<qa-password>"}'

# 2. Confirm the session resolves cross-site exactly as the SPA's bootstrap() does.
curl -sS -b /tmp/ipop-qa.cookies https://api.ipop.ai/me   # → the QA identity, not 401
```

For browser-driven QA, seed the same `rid` cookie into the automation context for `api.ipop.ai`
(domain-scoped, `Secure`, `SameSite=None`) before loading `https://ipop.ai`; AuthGate then reaches
`phase=ready` instead of redirecting. The existing #171 self-QA loop (`apps/server/src/selfqa/`) drives
the real sign-in form and needs no cookie injection.

Because the two halves deploy on **independent pipelines**, they can drift: a stale web bundle can run
against a newer API (or a preview bundle can be mistaken for prod). #366 (ADR-0366) makes that drift
**detectable** — this guide is the runbook.

## 1. Web origin config (build-time)

The console resolves the API origin from `VITE_API_BASE_URL` (`apps/web/src/api/config.ts`):

- **Same-origin** (local dev via the Vite proxy, or a single-origin deploy): leave it unset — requests stay
  server-relative (`/me`, `/ws`, `/version`).
- **Split deploy** (the ipop.ai production posture): set `VITE_API_BASE_URL=https://api.ipop.ai` in the
  Vercel project's environment variables. REST calls and the WebSocket then go cross-origin.

## 2. Deploying current `main`

- **Web:** Vercel auto-deploys on every push to `main`. `vercel.json` pins the build:
  `installCommand` = `pnpm install --frozen-lockfile`, `outputDirectory` = `apps/web/dist`, and a SPA
  rewrite of everything to `/index.html`. To force a fresh deploy, push to `main` or trigger a redeploy
  from the Vercel dashboard (use **"Redeploy" without build cache** if you suspect a stale asset cache).
- **API:** `fly-deploy.yml` redeploys `reload-api` on every push to `main` touching `platform/**`. The Fly
  `[deploy] release_command` runs migrate → preflight → smoke on a one-off VM **before** traffic shifts, the
  rollout is health-gated on `/readyz`, and a final step (#292) asserts the live `/version` is the deployed
  commit. A manual redeploy is `workflow_dispatch` on that workflow (or `flyctl deploy -a reload-api`).

## 3. Build stamps — the freshness receipt

Both halves stamp the deployed commit so freshness is a SHA comparison, not a guess:

| Side | Mechanism | Read it at |
|---|---|---|
| API | `Dockerfile` `ARG GIT_SHA` → `ENV GIT_SHA`; CI passes `--build-arg GIT_SHA=${{ github.sha }}` (#292) | `GET https://api.ipop.ai/version` → `{"version":"<sha>"}` |
| Web | `vercel.json` `buildCommand` maps `VERCEL_GIT_COMMIT_SHA` → `VITE_RELOAD_BUILD_SHA`, which Vite inlines into the bundle (#366) | `import.meta.env.VITE_RELOAD_BUILD_SHA` (in-bundle); the console reads it to compare against the API |

An un-stamped build (local, or any build without the arg/env) reports an **empty** SHA, which every
consumer treats as **"unknown"** — never a confirmed match or mismatch.

## 4. Verifying web ↔ API parity

### In-app (owner workspace)

The console fetches the API `/version` once and compares it to the web bundle's `VITE_RELOAD_BUILD_SHA`
via the pure, fail-closed `decideVersionParity` (`apps/web/src/components/console/version-check.ts`). On a
**confirmed mismatch** it shows a banner ("This page is out of sync with the API") with both short SHAs and
a reload control. It is **default-OFF + owner-workspace-first** (epic rail) — set, in the Vercel env:

```
VITE_RELOAD_VERSION_CHECK_UI=true
VITE_RELOAD_VERSION_CHECK_OWNER_WORKSPACE_ID=<the owner workspace id>
```

With these unset (the default), the check never runs and prod is byte-for-byte unchanged. A `match`,
an `unknown` verdict (unstamped build / unreachable API), or a still-loading state all render nothing — the
banner never false-alarms.

### From a shell / CI (acceptance check, #366 §3)

Capture both SHAs from the live hosts and assert they correspond:

```sh
# The commit the running API serves (#292):
api_sha=$(curl -fsS https://api.ipop.ai/version | sed 's/.*"version":"\([^"]*\)".*/\1/')

# The commit the live web bundle was built from (#366): VITE_RELOAD_BUILD_SHA is inlined into the JS bundle.
web_js=$(curl -fsS https://ipop.ai/ | grep -o '/assets/index-[^"]*\.js' | head -1)
web_sha=$(curl -fsS "https://ipop.ai${web_js}" | grep -o 'VITE_RELOAD_BUILD_SHA[^,]*' )   # inspect the inlined value

echo "api=$api_sha web(bundle)=$web_sha"   # one should be a prefix of the other
```

> The web stamp is inlined as a string literal in the hashed `index-*.js`; the exact extraction depends on
> the minified output, so treat the snippet above as a starting point and confirm by eye. The authoritative,
> always-correct check is the in-app banner above — it runs the same `decideVersionParity` the unit tests pin.

The deploy is **fresh** when the API `/version` equals the latest `main` commit AND the web bundle SHA is
the same commit (one may be the abbreviated form of the other). If they diverge, redeploy the stale side
(Vercel redeploy / `flyctl deploy`) — both are reversible (Vercel/Fly rollback).
