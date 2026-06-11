# Reload Platform — Operations Runbook (#19)

How to deploy, observe, and recover the Reload platform. Covers the full stack
(server + Postgres + Redis). See [ADR-0019](adrs/0019-deploy-observability.md) for the
decisions behind this; [the spec](specs/19-deploy.md) for scope.

## Stack at a glance
- **server** — Fastify API (`apps/server`), container image `reload-server`, port `3000`.
- **postgres** — Postgres 16, the system of record (per-workspace tenant data).
- **redis** — Redis 7, used by realtime/caching paths.
- **migrate** — one-shot job that applies pending migrations on deploy, then exits.

Config is entirely via environment variables (12-factor): `PORT`, `DATABASE_URL`,
`REDIS_URL`. Defaults for local dev are in `.env.example`. **Never commit a real `.env`.**

---

## Deploy

### Full stack (one pipeline)
From `platform/`:
```bash
docker compose --profile full up -d --build
```
This builds the image, runs `migrate` (apply pending migrations) **before** the server
starts (the server `depends_on` `migrate` completing successfully and on db/redis health),
then starts the server. The server reports **healthy** only once `GET /readyz` passes.

Verify:
```bash
curl -s localhost:3000/readyz     # {"status":"ready","db":"up","redis":"up"}
curl -s localhost:3000/livez      # {"status":"ok"}
```

> Plain `docker compose up -d` (no `--profile full`) starts **only** Postgres + Redis —
> the local dev/demo workflow used by issues #1–#4. The app services are gated behind the
> `full` profile so they don't collide with a tsx-run dev server.

### Single container
The image self-migrates on boot (`docker-entrypoint.sh` runs `migrate up` then starts):
```bash
docker build -f apps/server/Dockerfile -t reload-server .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://reload:reload@HOST:5432/reload \
  -e REDIS_URL=redis://HOST:6379 reload-server
```

### Fly deploy (api.ipop.ai)
The production API (`reload-api` on Fly, https://api.ipop.ai) deploys via
`.github/workflows/fly-deploy.yml` on every push to `main` touching `platform/**`, authenticated by the
`FLY_API_TOKEN` repo secret. The image self-migrates on boot, and the workflow polls `/readyz` as its
own proof. Manual deploy from a flyctl-logged-in machine:
```bash
cd platform && flyctl deploy --remote-only --config fly.toml -a reload-api
curl -s https://reload-api.fly.dev/readyz   # {"status":"ready","db":"up","redis":"up"}
```
**Full setup (token minting, app secrets, rollback): [runbooks/fly-deploy.md](runbooks/fly-deploy.md).**

### Migrations
Migrate-on-deploy is automatic (the `migrate` service / entrypoint). Manual control:
```bash
pnpm --filter @reload/server db:migrate     # apply pending (up)
pnpm --filter @reload/server db:rollback    # revert last migration (down)
pnpm --filter @reload/server db:reset       # revert all, then re-apply
```
Each `NNNN_name.sql` has a paired `NNNN_name.down.sql`; applied migrations are tracked in
the `_migrations` table. CI proves the down→up path stays clean on every PR.

---

## Rollback

**App rollback** — redeploy the previous image tag:
```bash
docker compose --profile full up -d --build   # or pin a known-good image tag
```
**Schema rollback** — if a migration is the problem, revert it (paired `.down.sql`):
```bash
pnpm --filter @reload/server db:rollback
```
Roll the schema back **before** rolling the app back if the new schema is incompatible
with the old code. If data has already been written under the new schema, prefer a
forward fix + restore from backup over a destructive down-migration.

---

## Backup & restore

**Backup** (logical `pg_dump`, gzipped, timestamped):
```bash
bash scripts/backup.sh [output-dir]    # default ./backups/reload-YYYYmmdd-HHMMSS.sql.gz
```
**Restore** (DESTRUCTIVE — overwrites the live DB; take a fresh backup first):
```bash
bash scripts/restore.sh backups/reload-YYYYmmdd-HHMMSS.sql.gz
```
For real environments: schedule `backup.sh` (cron/CI), ship artifacts to offsite/object
storage, and test restores regularly. Point-in-time recovery (WAL archiving) is a
follow-up beyond this logical-dump baseline.

---

## Observability

### Probes
| Endpoint | Meaning | Use |
|---|---|---|
| `GET /livez` | process is up (always 200) | container **restart** probe |
| `GET /readyz` | deps reachable (200 ready / 503 not_ready) | **traffic**/load-balancer gate |
| `GET /healthz` | human summary (`ok`/`degraded`, always 200) | dashboards / quick check |
| `GET /metrics` | Prometheus text exposition | scraping |

All four are unauthenticated and expose **no tenant data**.

### Correlation ids (tracing a request end-to-end)
Every request has an `x-request-id` — adopted from the client header if present (so an
upstream id propagates), else generated (uuidv7). It is:
- echoed in the `x-request-id` **response header**, and
- stamped as `requestId` on **every log line** for that request, alongside `workspaceId`,
  `memberId`, and `kind` once the caller is resolved.

To trace one request across logs:
```bash
docker compose logs server | grep '"requestId":"<the-id>"'
```
W3C `traceparent` is also echoed; an OpenTelemetry exporter can adopt this seam without
code changes (follow-up).

### Metrics & SLOs
`/metrics` exposes `http_requests_total{method,route,status}` (labelled by **route
template**, not raw path — bounded cardinality; tenant id is intentionally **not** a
label), `http_request_duration_seconds` (histogram), `http_requests_in_flight`, and
process gauges.

Scrape config and SLO alert rules are committed as code:
- `observability/prometheus.yml` — scrape job for the server.
- `observability/alerts.yml` — SLO alerts:
  - **Availability** 99.5% → alert when 5xx ratio > 0.5% for 5m.
  - **Latency** p95 < 500ms → alert when p95 > 0.5s for 5m.
  - **Liveness** → alert when the target is down > 1m.

Standing up managed Prometheus/Grafana/Alertmanager is environment-specific; wire these
files into your monitoring stack.

### Uptime monitoring (#108)
An **external** heartbeat watches the two public URLs from GitHub's infrastructure — *not* ours, so it
notices when our box is down (a Prometheus alert on a dead server can't fire). The scheduled workflow
`.github/workflows/uptime-check.yml` runs every 5 min and probes:

| Target | URL | Healthy when |
|---|---|---|
| `api` | `https://api.ipop.ai/readyz` | HTTP 200 **and** body contains `ready` |
| `web` | `https://ipop.ai/` | HTTP 200 |

On failure it **opens a GitHub issue** (label `uptime-alert`); while an issue is already open it does
nothing (no 5-min spam); on recovery it comments and closes it. **The open issue is the alert state** —
there is no database, so the monitor survives the laptop closing. Issues fan out to the owner's
notifications and the Founder Console (#104) issue feed. The decision logic is the unit-tested pure core
`apps/server/src/uptime/check.ts`; run it by hand (report-only, no token needed):

```bash
pnpm --filter @reload/server uptime:check     # ✓/✗ per target; exits non-zero if anything is down
```

Override the watch list with the `UPTIME_TARGETS` repo variable (a JSON array of probe targets); disable
the workflow per-fork with the `UPTIME_DISABLED=true` repo variable. The monthly hosting bill is bounded
separately — see the [cost-ceiling runbook](playbooks/cost-ceiling.md).

---

## Cloud agent execution (#25)
Agents run server-side on an `AgentRuntime` backend so work continues after a client disconnects
(ADR-0025). Configure via env:

| Var | Default | Meaning |
|---|---|---|
| `AGENT_RUNTIME` | `local` | `local` (host child process; dev/CI, no cloud) or `sandbox` (Vercel Sandbox per session). |
| `AGENT_HARNESS_CMD` / `AGENT_HARNESS_ARGS` | `bash` / `["scripts/agent-harness-demo.sh"]` | The **trusted** harness command (never client-supplied); model-agnostic. |
| `AGENT_WALLCLOCK_MS` | `600000` | Hard wall-clock cap per session. |
| `AGENT_IDLE_MS` | `120000` | Idle (no-output) cap; resets on each output chunk. |
| `AGENT_MEMORY_MB` | unset | Advisory memory cap passed to the sandbox provider. |
| `AGENT_SECRETS` | unset | Per-tenant secrets as JSON: `{"*":{KEY:val},"<workspaceId>":{KEY:val}}`. Injected as runtime env at provision; **never** logged or snapshotted. |
| `AGENT_SECRET_KEYS` | unset | Comma list of `process.env` keys to pass through as secrets. |

**`sandbox` backend** additionally requires `npm i @vercel/sandbox` and
`VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID`. The SDK is loaded lazily — `local`
deploys never need it. Metrics: `agent_sessions_total{runtime,status}`, `agent_sessions_active`,
`agent_sandbox_spinup_seconds`. Per-session logs bind `{ sessionId, workspaceId, runtime }`.

> Flipping the org-wide default to `sandbox` is an explicit "ask first" change — `local` stays
> the default so nothing incurs cloud spend without intent.

## Incident quick reference
| Symptom | First checks |
|---|---|
| `/readyz` 503 | `docker compose ps`; is postgres/redis healthy? check `DATABASE_URL`/`REDIS_URL`. |
| 5xx spike (ReloadHighErrorRate) | find the `requestId` in logs; `BubbleUp` by `route`/`status`; recent deploy? roll back. |
| High latency (ReloadHighLatencyP95) | check db load; `http_requests_in_flight`; slow `route` in metrics. |
| Server won't start | `docker compose logs migrate` — did migrations fail? then `docker compose logs server`. |
| Suspected cross-tenant access | the tenant-isolation integration test is the contract; reproduce with two workspaces. |
| Agent session stuck / not reaped | check `agent_sessions_active`; a session past its caps becomes `timeout`/`idle_reaped`; force-stop with `POST /channels/:cid/agent-sessions/:id/cancel`. |
| `AGENT_RUNTIME=sandbox` can't start a session | is `@vercel/sandbox` installed + `VERCEL_*` set? the error names the missing piece. Fall back to `local`. |

## Verifying a deploy (acceptance demo)
```bash
bash scripts/demos/19-deploy.sh      # full stack → probes → correlation id → tenant isolation
```
Recorded as `docs/demos/19-deploy.mp4` and regenerated as a CI `demo-video` artifact.
