# ipop.ai Deployment (#108)

How the Reload web console is hosted on Vercel at **ipop.ai**, and what remains before the
platform is fully functional online. Owner-testing target.

## What is deployed

| Piece | Status | Where |
| --- | --- | --- |
| Web console (`@reload/web`, Vite/React SPA) | ✅ Live in production | Vercel project `agent-skills` (team `gagans-projects-0e63a02f`) |
| API (`@reload/server`, Fastify + Postgres + Redis + `/ws`) | ✅ Hosted on Fly.io | `reload-api.fly.dev` → see [API hosting — Fly.io](#api-hosting--flyio-apiipopai) |
| `ipop.ai` + `www.ipop.ai` | ✅ Attached to project, awaiting DNS | DNS records below |

**Production URLs**

- Vercel alias: <https://agent-skills-sigma.vercel.app>
- Custom domain (after DNS): <https://ipop.ai>, <https://www.ipop.ai>

## Vercel project configuration

The web app is a package inside the `platform/` pnpm workspace and depends on `@reload/shared`
(`workspace:*`). A standalone `platform/apps/web` build can't resolve that workspace symlink, so
the project **Root Directory is set to `platform/`** (the workspace root) and the build is driven
by `platform/vercel.json`:

```jsonc
{
  "framework": null,
  "installCommand": "pnpm install --frozen-lockfile", // installs the whole workspace
  "buildCommand": "pnpm --filter @reload/web build",   // tsc --noEmit && vite build
  "outputDirectory": "apps/web/dist",                  // the SPA bundle that gets served
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] // SPA fallback
}
```

> The owner directive asked for Root Directory `platform/apps/web`. We use `platform/` instead
> because the web package needs the workspace lockfile to resolve `@reload/shared`; the served
> artifact is still `apps/web/dist` (the web console), so the acceptance criterion — production
> serves the console, no 404 — is met. Root Directory was set via the Vercel REST API using the
> already-authenticated CLI token (no dashboard, no new credentials).

### Deploy / redeploy (CLI)

```bash
# from the repo root, project already linked (.vercel/ is gitignored)
vercel deploy --prod --yes
```

Production builds must run from the repo root so the `platform/` Root Directory setting resolves.
Verified serving: `curl -sI https://agent-skills-sigma.vercel.app/` → `HTTP 200`, correct
`<title>`, hashed JS asset 200, deep-path SPA fallback 200.

## DNS records (owner action at the registrar)

`ipop.ai` and `www.ipop.ai` are attached to the `agent-skills` project and verified at the Vercel
account level, but `misconfigured: true` until the records below resolve. Set these wherever the
domain's **authoritative DNS** lives (see the nameserver note).

| Type | Host | Value | Notes |
| --- | --- | --- | --- |
| A | `@` (ipop.ai) | `216.198.79.1` | Vercel anycast (rank 1). Add the second A below too. |
| A | `@` (ipop.ai) | `64.29.17.1` | Second anycast IP (rank 1 set). |
| CNAME | `www` | `cname.vercel-dns.com.` | Standard Vercel CNAME. |

Simpler legacy alternative for the apex (single record, rank 2): `A @ 76.76.21.21`.

⚠️ **Nameserver note.** `ipop.ai`'s nameservers currently point to **Cloudflare**
(`chloe.ns.cloudflare.com` / `plato.ns.cloudflare.com`), not Namecheap and not Vercel. The records
above only take effect at the **authoritative** DNS host. So the owner must either:

1. Add the records in **Cloudflare** (current authoritative DNS), **or**
2. At Namecheap, switch the domain back to Namecheap BasicDNS, then add the records there, **or**
3. Point nameservers to Vercel (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`) and let Vercel manage
   records automatically.

Vercel re-verifies automatically and emails on completion. Check status anytime with
`vercel domains inspect ipop.ai`.

### Domain reassignment performed

`ipop.ai` and `www.ipop.ai` were previously attached to the `ipop-frontdesk` Vercel project, but
that project's DNS was never pointed at Vercel (nameservers at Cloudflare), so nothing was being
served from it. Per the owner directive the two domains were detached from `ipop-frontdesk` and
attached to `agent-skills`. `ipop-frontdesk` now retains only its `*.vercel.app` URL. This is
reversible: re-running `vercel domains add <domain>` against the other project moves them back.

## Pointing the web console at a hosted API

The web client is now origin-configurable (#108). By default (`VITE_API_BASE_URL` unset) it makes
**same-origin** requests — correct for local dev (Vite proxy) and a single-origin deployment.

For a split deployment (web on Vercel, API on a separate always-on host), set a Vercel build-time
env var:

```bash
vercel env add VITE_API_BASE_URL production   # e.g. https://api.ipop.ai
vercel deploy --prod --yes
```

REST calls and the WebSocket (`/ws`) are then sent to that origin.

**Cross-origin auth — why it works here.** `ipop.ai` (web) and `api.ipop.ai` (API) are *cross-origin*
but *same-site* (shared registrable domain `ipop.ai`), so the `SameSite=Lax`, `Secure`, httpOnly
`rid` cookie set by the API is sent on requests to `api.ipop.ai` — no `SameSite=None` needed. The
browser still enforces CORS for the cross-origin `fetch`, so the server allow-lists the web origin
for credentialed CORS (see below). If you ever host the API on a *different* site, you'd need
`SameSite=None; Secure` instead.

Until DNS for `api.ipop.ai` resolves, the console **loads and shows a clear "API not connected"
state** (it no longer crashes — see #121). Once DNS + the Fly cert are live, it talks to the API.

## API hosting — Fly.io (`api.ipop.ai`)

The Fastify API is a long-lived process (WebSocket gateway, Redis pub/sub, Postgres, migrate-on-
deploy) — Vercel functions can't run it, so it lives on Fly.io. Built from the existing
`apps/server/Dockerfile`; config in `platform/fly.toml`.

| Resource | Fly app | Tier / cost |
| --- | --- | --- |
| API server | `reload-api` (region `yyz`) | 1× `shared-cpu-1x` / 512 MB, always-on (`min_machines_running = 1`) |
| Postgres | `reload-api-db` | flex (Repmgr), `shared-cpu-1x`, 1 GB volume — standard machine billing |
| Redis (Upstash) | `reload-api-redis` | Pay-as-you-go, $0.20 / 100K commands (no ProdPack) |

`DATABASE_URL` (set by `fly postgres attach`) and `REDIS_URL` (`fly secrets set`) are **secrets**,
never committed. Non-secret config (`PORT`, `RELOAD_PROFILE=prod`, `AGENT_HARNESS=demo`,
`RELOAD_WEB_ORIGIN`) is in `fly.toml`.

### Provision + deploy (from `platform/`)

```bash
fly apps create reload-api --org personal
fly postgres create --name reload-api-db --org personal --region yyz \
  --vm-size shared-cpu-1x --volume-size 1 --initial-cluster-size 1
fly postgres attach reload-api-db --app reload-api          # sets DATABASE_URL secret
fly redis create --name reload-api-redis --org personal --region yyz \
  --no-replicas --enable-eviction --plan <pay-as-you-go-id>  # see `fly redis create`
fly secrets set REDIS_URL="redis://…" --app reload-api --stage
fly deploy --ha=false --app reload-api                       # builds image, migrates, starts
```

Verified live: `https://reload-api.fly.dev/readyz` → `200 {"status":"ready","db":"up","redis":"up"}`;
migrations applied on deploy (entrypoint log); `OPTIONS`/`GET` to the API return CORS headers for
`https://ipop.ai`.

### CORS (`apps/server/src/http/cors.ts`)

A dependency-free root hook, gated on `RELOAD_WEB_ORIGIN` (comma-separated allowlist). It reflects an
allow-listed `Origin` with `Access-Control-Allow-Credentials: true` + `Vary: Origin`, and answers
preflight `OPTIONS` with `204`. No-op when unset (local/same-origin unchanged).

### Google OAuth sign-in runbook (#1288)

Production sign-in must be either ready or deliberately in maintenance. The release preflight fails
`prod` by default when any of these are missing, and the public smoke endpoint shows only missing key
names, never values:

```bash
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://api.ipop.ai/auth/google/callback
```

Set or rotate them in Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client IDs.
The authorized redirect URI in Google must match `GOOGLE_OAUTH_REDIRECT_URI` byte-for-byte, including
scheme, host, path, and trailing slash behavior. After changing credentials:

```bash
fly secrets set GOOGLE_OAUTH_CLIENT_ID="..." --app reload-api
fly secrets set GOOGLE_OAUTH_CLIENT_SECRET="..." --app reload-api
fly secrets set GOOGLE_OAUTH_REDIRECT_URI="https://api.ipop.ai/auth/google/callback" --app reload-api
fly deploy --ha=false --app reload-api
curl -s https://api.ipop.ai/auth/google/status
curl -I "https://api.ipop.ai/auth/google/start?domain=example.com"
```

Expected smoke result: `/auth/google/status` returns `configured:true`, and `/auth/google/start`
returns a `302` to `https://accounts.google.com/o/oauth2/v2/auth`. If status returns
`configured:false`, fix the listed env var names and rerun the preflight before marking the
deployment healthy. Never paste the client secret into logs, GitHub issues, or browser screenshots.

### Enabling billing / Stripe checkout (#125 — owner action)

The pricing page (`/pricing`) and the #98 revenue rails run **dark on the no-network `none` provider**
until the owner pastes the Stripe keys. The repo contains **zero** key material; these names live only as
Fly secrets, and **only the owner runs these** — the agent never handles key values.

```bash
# 1. Paste the keys from the Stripe dashboard (Mathematricks Fund account). Never commit these.
fly secrets set STRIPE_SECRET_KEY=sk_live_…      --app reload-api
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_…     --app reload-api

# 2. Switch the provider on (config, not a secret) and redeploy so the SDK path is selected.
fly secrets set BILLING_PROVIDER=stripe           --app reload-api
fly deploy --ha=false --app reload-api

# 3. Mint the real products/prices ONCE (idempotent — a second run is a no-op).
fly ssh console --app reload-api \
  -C "pnpm -C platform/apps/server billing:bootstrap <workspaceId>"
```

Point a Stripe webhook endpoint at `https://api.ipop.ai/billing/webhook/<workspaceId>` (events:
`checkout.session.completed`); its signing secret is the `STRIPE_WEBHOOK_SECRET` above. A paid checkout
then activates the workspace's plan and updates its caps. **Outbound money stays structurally impossible**
(the provider seam has no refund/payout/transfer; refunds are a #13-gated manual dashboard action). Until
step 1, every surface works on `none` — `/pricing` renders, checkout returns the no-network URL, and CI
spends nothing.

### DNS for `api.ipop.ai` (owner action — Cloudflare, DNS-only)

Fly issued the cert; point the hostname at the app with **one** of:

| Option | Type | Host | Value |
| --- | --- | --- | --- |
| A+AAAA (recommended) | A | `api` | `66.241.124.242` |
| | AAAA | `api` | `2a09:8280:1::125:f303:0` |
| CNAME (alternative) | CNAME | `api` | `ke1n6mr.reload-api.fly.dev` |

Keep it **DNS-only** (grey cloud) in Cloudflare so Fly terminates TLS. Check progress with
`fly certs check api.ipop.ai`. (If the record is ever proxied, also add
`TXT _fly-ownership.api.ipop.ai → app-ke1n6mr`.)

### Guardrails honored

No payment method was added and no new paid plan was accepted: Postgres runs on standard machine
billing already on the account, and Redis uses the default **Pay-as-you-go** tier (ProdPack, the only
$/mo upsell, was declined). Cost is kept minimal (1 small always-on VM + usage-metered Redis).
