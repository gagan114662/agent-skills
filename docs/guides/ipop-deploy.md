# ipop.ai Deployment (#108)

How the Reload web console is hosted on Vercel at **ipop.ai**, and what remains before the
platform is fully functional online. Owner-testing target.

## What is deployed

| Piece | Status | Where |
| --- | --- | --- |
| Web console (`@reload/web`, Vite/React SPA) | ✅ Live in production | Vercel project `agent-skills` (team `gagans-projects-0e63a02f`) |
| API (`@reload/server`, Fastify + Postgres + Redis + `/ws`) | ⛔ Not hosted — blocked | See [API hosting](#api-hosting-blocked) |
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

REST calls and the WebSocket (`/ws`) are then sent to that origin. **Cross-origin auth caveat:**
the `rid` session cookie is httpOnly, so the server must set it with `SameSite=None; Secure` and
allow-list the web origin for credentialed CORS, otherwise login won't stick across origins.

Until the API is hosted, the console **loads** but cannot authenticate (same-origin API paths fall
through to the SPA `index.html`). That is expected for this owner-testing milestone.

## API hosting (blocked)

Standing up the Fastify API was evaluated strictly against already-authenticated credentials and is
**blocked on two independent grounds**:

1. **Architecture — Vercel can't run this server.** `@reload/server` is a long-lived process: a
   persistent WebSocket gateway (`realtime/gateway.ts`, `ws`), Redis pub/sub (`ioredis`), a
   Postgres pool (`pg`), and migrate-on-deploy (`docker-entrypoint.sh`). Vercel Functions are
   stateless and have no persistent connections — incompatible. Issue #108 itself mandates an
   always-on runtime (Fly/Railway/Render) and notes "Vercel cannot run PG/Redis."
2. **Provisioning guardrail — every remaining path needs new terms/accounts.**
   - Fly / Railway / Render: require creating a **new third-party account** and accepting new
     (paid) terms. Prohibited by the task guardrail.
   - Vercel Marketplace storage (Neon Postgres / Upstash Redis): `vercel integration list` →
     *No resources found*. Provisioning requires `vercel integration add`, which requires
     `vercel integration accept-terms` (accepting a **new marketplace legal agreement**).
     Prohibited by the task guardrail. And even with storage, ground #1 still blocks the runtime.

**Exact blocking step:** provisioning an always-on API runtime — `vercel integration accept-terms`
for a Marketplace database, or creating a Fly/Railway/Render account — both require accepting new
third-party terms, which this task is not authorized to do. The Dockerfile + `docker-entrypoint.sh`
(migrate-on-deploy, `/readyz` health gate) are ready; deploying them to a container host is the
remaining owner decision.
