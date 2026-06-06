# Spec: Reload Platform — Multi-tenant Deployment + Observability (Issue #19)

> Implements [#19](https://github.com/gagan114662/agent-skills/issues/19). Phase 4 — UI & polish (infra). Depends on #1 (foundation), #3 (auth).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every stage governed by a skill in `skills/`.

## Objective
**What:** Make the Reload server **operable, observable, and provably multi-tenant** in a deployed environment: every request path is workspace-scoped end-to-end, every request is traceable via a correlation id, the process exposes liveness/readiness/metrics, and the whole stack (server + Postgres + Redis) deploys from one pipeline with migrations applied on deploy.

**Why:** reload.chat is a multi-tenant SaaS that runs 24/7 with agents acting autonomously. Before more product surface lands, the platform needs the operational floor: you must be able to **deploy it, watch it, trace a single request across tenants, and prove tenant A can never read tenant B's data.** This issue is the head of the operability lane — #5+ realtime and agent autonomy ride on top of a server you can actually run and observe in production.

**Who:** Operators (deploy/rollback/restore, dashboards, alerts) and every API caller (human session + agent token), whose requests are now correlation-tagged and tenant-bound by construction.

### Acceptance criteria (from #19 BUILD/TDD)
1. **One pipeline deploys the full stack to an environment** — `docker compose up` brings up Postgres + Redis + the server, with migrations applied on deploy (migrate-on-deploy), driven by a committed `Dockerfile` + compose manifest; CI builds the image.
2. **A request is traceable end-to-end via a correlation id** — every request carries an `x-request-id` (accepted from the client or generated), echoed in the response header and stamped on every log line for that request, alongside the resolved `workspaceId`/`memberId` (tested).
3. **Tenant isolation is proven by test** — an integration test demonstrates workspace **A cannot read, list, or post into** workspace **B**'s channels/messages (cross-tenant access → 403/404), carrying forward the #3 IDOR discipline.
4. **Runbook** at `platform/docs/operations.md` covering deploy / rollback / restore + observability (probes, metrics, correlation ids, SLOs/alerts).

### In scope
- **Tenant scoping guardrails:** a centralized identity/workspace guard so no route can forget the IDOR check; cross-tenant leakage tests.
- **Structured logging:** request + tenant correlation ids on every log line (pino, already the Fastify logger).
- **Observability endpoints:** `GET /livez` (liveness), `GET /readyz` (readiness — 503 when a dependency is down), `GET /metrics` (Prometheus text exposition). `GET /healthz` (from #1) retained.
- **Tracing hooks:** an extensible per-request trace context (request id propagated; W3C `traceparent` accepted/echoed) so an OpenTelemetry exporter can be wired in later without touching call sites.
- **Deployment config:** server `Dockerfile` (multi-stage), `.dockerignore`, `docker-entrypoint.sh` (migrate-on-deploy → start), full-stack `docker-compose.yml` (postgres + redis + one-shot `migrate` + server), secrets via env (`.env`, never committed).
- **Migrations-on-deploy:** the migrate step runs `db:migrate up` before the server accepts traffic.
- **Operability config-as-code:** Prometheus scrape config + SLO alert rules under `platform/observability/`; `pg_dump`/`pg_restore` backup + restore scripts; the `operations.md` runbook.

### Out of scope (deferred / documented-not-automated)
- **A live, hosted Grafana/Prometheus/Alertmanager stack** — SLOs and alert rules are committed **as code**; standing up managed monitoring is an environment concern documented in the runbook, not provisioned here.
- **Cloud IaC (Terraform/K8s manifests) for a specific provider** — the containerized stack + compose is the portable deploy unit; a provider-specific target is a follow-up.
- **Automated/scheduled backups to object storage** — backup/restore is scripted and documented; the cron/offsite wiring is environment-specific.
- **A full OpenTelemetry SDK + collector wiring** — we add the propagation seam and span-friendly context; the exporter is a drop-in follow-up.
- **Per-tenant resource quotas / rate limiting** — noted as a hardening follow-up in the ADR.

## Observability endpoints (no auth — probes/scrapers, no tenant data leaked)
```
GET /livez     200 always while the process is up            { status: "ok" }
GET /readyz    200 when db+redis reachable, else 503          { status, db, redis }
GET /healthz   200 with status ok|degraded (from #1)          { status, db, redis }
GET /metrics   200 text/plain; Prometheus exposition          http_requests_total{...} etc.
```
`/livez` and `/readyz` are the container probes; `/healthz` stays the human-facing summary; `/metrics` is scraped. None of these read tenant data.

## Correlation / tracing
- Fastify `genReqId` reads `x-request-id` from the client (so an upstream id propagates) or generates a uuidv7. The id is set as `requestId` on the request log child and echoed as the `x-request-id` response header.
- A global `preHandler` resolves the caller once (memoized on the request — no double DB lookup) and binds `{ workspaceId, memberId, kind }` to the request log child, so **every** log line for a request is tenant-attributed.
- W3C `traceparent` is accepted and echoed; the request context is shaped so an OTel exporter can adopt it without changing routes.

## Tenant scoping (carry forward #3 IDOR discipline)
A small `auth/guard.ts` centralizes the two checks every route repeats today:
- `requireIdentity(req, reply)` → resolved `Identity` or `401`.
- `assertWorkspace(identity, wid, reply)` → `403` on mismatch.
Routes adopt the helper so the workspace check can't be forgotten; behavior is identical to #4 (still 401/403/404 exactly as before). The new **cross-tenant leakage integration test** is the regression guard.

## Metrics (dependency-free registry)
A tiny in-process Prometheus registry (no new runtime dependency — consistent with the lean `@reload/shared` rule and the committed frozen lockfile) records:
- `http_requests_total{method,route,status}` — counter, `route` is the **route template** (`/channels/:cid/messages`), never the raw path, to bound cardinality. Tenant id is **not** a metric label (high-cardinality anti-pattern); it lives in logs/traces instead.
- `http_request_duration_seconds` — histogram (a few buckets).
- `http_requests_in_flight` — gauge.
- `process_uptime_seconds`, `process_resident_memory_bytes` — process gauges.
Recorded in an `onResponse` hook.

## Deployment
- **Dockerfile** (multi-stage): pnpm install + workspace build → slim `node:22-alpine` runtime running `dist/index.js` as a non-root user.
- **docker-entrypoint.sh:** runs `db:migrate up` (migrate-on-deploy) then `exec node dist/index.js`. In compose this is a dedicated one-shot `migrate` service the `server` depends on, so migrations run once and the server starts only after they succeed.
- **docker-compose.yml:** extends the existing postgres+redis with `migrate` (one-shot) + `server`; healthchecks gate startup ordering; `server` exposes `/livez` + `/readyz` as container healthcheck.
- **Secrets:** all config via env (`DATABASE_URL`, `REDIS_URL`, `PORT`); `.env.example` documents them; real `.env` never committed (already in `.gitignore`).

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):** `/livez` returns 200; `/metrics` returns Prometheus text including `http_requests_total` and increments on a request; `x-request-id` is generated when absent and echoed when supplied; metrics registry format is valid.
- **Integration (real Postgres/Redis — `pnpm test:integration`):** **tenant isolation** — workspace A's session and agent token get 403/404 on B's channels/messages (list, read, post); `/readyz` returns 200 with deps up; correlation id present on an authenticated request with the tenant bound in context.
- Runs in the existing `quality` (unit) + `integration` CI jobs; the demo (`scripts/demos/19-deploy.sh`, recorded as the PR video) proves the full stack boots, migrates, serves probes/metrics, traces a request, and blocks cross-tenant access.

## Boundaries
- **Always:** scope every query by workspace (#3 IDOR); tag every log line with request id + tenant; keep probe/metrics endpoints free of tenant data; write the failing test first; attach the demo video.
- **Ask first:** adding a real runtime dependency (prom-client/OTel SDK); changing the auth/identity contract; provider-specific IaC.
- **Never:** let a probe or metric leak cross-tenant data; merge without approval + video; commit a real `.env`.

## Success criteria
1. `docker compose up` → migrate runs → server healthy on `/readyz`; one pipeline, full stack.
2. A request's `x-request-id` is echoed and appears (with `workspaceId`) on its log lines (tested).
3. Tenant isolation integration test green: A → 403/404 on B's channels/messages.
4. `/livez`, `/readyz`, `/metrics` behave per contract (tested).
5. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; integration green in CI.
6. `platform/docs/operations.md` runbook + ADR-0019 + video `platform/docs/demos/19-deploy.mp4`.

## Plan (atomic, from #19)
1. Correlation ids + structured logging (request + tenant) — *slice 1*.
2. Observability endpoints (`/livez`, `/readyz`, `/metrics`) + metrics registry — *slice 2*.
3. Tenant isolation guard + cross-tenant leakage test — *slice 3*.
4. Deployment config (Dockerfile, entrypoint, full-stack compose, migrate-on-deploy) + observability/backup config-as-code — *slice 4*.
5. Runbook + ADR + demo + CI image build — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR; reviewed and merged by @gagan114662 on the video). No merge without approval.
