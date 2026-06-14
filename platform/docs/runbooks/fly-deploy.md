# Runbook — Fly API deploy (api.ipop.ai)

> Issue: [#138](https://github.com/gagan114662/agent-skills/issues/138) · ADR: [0138-pop-identity-channels-deploy](../adrs/0138-pop-identity-channels-deploy.md) · App: `reload-api` (Fly, region `yyz`)
>
> The web console (https://ipop.ai) auto-deploys on Vercel. The API (https://api.ipop.ai) deploys to
> Fly via `.github/workflows/fly-deploy.yml` on every push to `main` touching `platform/**`. The image
> self-migrates on boot, so a deploy is the whole story — no separate migration step.

## Stack

| Piece | Where |
| --- | --- |
| Web console | Vercel → https://ipop.ai (auto-deploy on push to main) |
| API | Fly app `reload-api` → https://api.ipop.ai / https://reload-api.fly.dev |
| Build | `platform/apps/server/Dockerfile`, context `platform/` (run flyctl from `platform/`) |
| Migrate-on-deploy | `apps/server/docker-entrypoint.sh` runs `migrate.js up` before starting the server |
| Readiness | `GET /readyz` → `{"status":"ready","db":"up","redis":"up"}` (Fly routes only when green) |

## One-time setup — the `FLY_API_TOKEN` secret

The deploy workflow authenticates to Fly with a single repo secret, `FLY_API_TOKEN`. It is referenced
by name and never echoed; an unset token makes the workflow **skip cleanly** (it won't fail red).

1. Mint a deploy token scoped to the app (from a machine logged into flyctl as the app owner):
   ```bash
   flyctl tokens create deploy -a reload-api
   ```
   Copy the printed token (starts with `FlyV1 …`). It is shown once.
2. Add it as a GitHub Actions secret on the repo:
   ```bash
   gh secret set FLY_API_TOKEN --repo gagan114662/agent-skills
   # paste the token at the prompt
   ```
   Or: GitHub → repo → Settings → Secrets and variables → Actions → New repository secret →
   name `FLY_API_TOKEN`, value the token.
3. Push to `main` (or run the workflow manually):
   ```bash
   gh workflow run fly-deploy.yml
   ```
   The run installs flyctl, runs `flyctl deploy --remote-only`, then polls `/readyz` as its own proof.

### App secrets (separate from the deploy token)

Runtime secrets live on the Fly app, set with `flyctl secrets set` (never committed, never in `fly.toml`):

```bash
flyctl secrets set DATABASE_URL='postgres://…' REDIS_URL='redis://…' -a reload-api
flyctl secrets list -a reload-api   # names + digests only — never prints values
```

Non-secret config (PORT, profile, CORS origins, `RELOAD_MARKETING_*`, model) lives in `fly.toml [env]`
and ships with the deploy.

## Real agents — connect Claude (#68, ADR-0068)

The app runs the **real** `claude-code` harness in production (`fly.toml [env] AGENT_HARNESS=claude-code`,
`claude` CLI baked into the image). Auth is **subscription-first and strictly per-tenant** — a workspace
runs agents on **its own** Claude subscription, never a pooled key.

### The one owner step (per workspace) — connect your Claude

1. On your machine, generate a long-lived token:
   ```bash
   claude setup-token
   ```
2. In the console: **Settings → Connect Claude**, paste the token, Connect. (The field is masked; the
   token is stored **encrypted** in the per-tenant vault and never shown again — only a fingerprint is.)

That's it. @mention a fleet agent (`@scout`, `@quill`, …) in its channel and it runs a real
`claude-sonnet-4-6` session (the deployment-default model — #242) billed to your subscription, replying
in-thread. A workspace that hasn't
connected gets a friendly in-channel "connect your Claude account" reply instead — it never crashes.

### Optional operator / platform secrets (set on the app, never committed)

```bash
# Encrypt the per-tenant token vault at rest (32-byte key as hex or base64). Strongly recommended in prod.
flyctl secrets set AGENT_CREDENTIALS_ENC_KEY="$(openssl rand -hex 32)" -a reload-api

# Fallback platform key — used ONLY for tenants who have connected nothing (an operator org key, not a
# user subscription). Omit it to require every workspace to connect its own.
flyctl secrets set ANTHROPIC_API_KEY='sk-ant-…' -a reload-api

# Observability: trace every agent session to Braintrust (no-op unless set).
flyctl secrets set BRAINTRUST_API_KEY='…' -a reload-api
```

> Compliance: one subscription is **never** pooled across workspaces. The vault is keyed by workspace;
> a session only ever sees its own workspace's token. Rotating `AGENT_CREDENTIALS_ENC_KEY` invalidates
> stored tokens (owners re-paste). Set it **before** the first connect so nothing is stored plaintext.

## Manual deploy (from a machine logged into flyctl)

```bash
cd platform
flyctl deploy --remote-only --config fly.toml -a reload-api
```

`--remote-only` builds on Fly's builders (no local Docker needed). The deploy returns only once the new
machine passes its `/readyz` health check.

## Verify a deploy

```bash
curl -s https://reload-api.fly.dev/readyz   # {"status":"ready","db":"up","redis":"up"}
curl -s https://api.ipop.ai/readyz          # same, via the custom domain
flyctl status -a reload-api                 # machine state + the deployed image tag
```

## Rollback

```bash
flyctl releases -a reload-api               # list releases (newest first)
flyctl deploy --image <previous-image-ref> -a reload-api   # redeploy a known-good image
```

If a **migration** is the problem, roll the schema back with the paired down-migration **before**
rolling the app back (see [operations.md → Rollback](../operations.md#rollback)); for data already
written under the new schema, prefer a forward fix + restore over a destructive down-migration.

## Notes

- The workflow's `paths: ["platform/**"]` filter means a web-only change also triggers an API redeploy.
  That's safe (the image is idempotent and self-migrating) — the web is still served by Vercel; the Fly
  redeploy is a no-op rollout of the same server.
- `RELOAD_MARKETING_ENABLED=true` / `RELOAD_MARKETING_SEED_WELCOME_TASKS=false` in `fly.toml [env]` turn
  on the marketing department fleet (#123) for the live product: every workspace is seeded on signup and
  idempotently backfilled on boot, with **no** welcome-session launches (no spend). See ADR-0138.

made by robots, steered by humans.
