# ADR-0019: Multi-tenant Deployment + Observability

- **Status:** Accepted (Gagan approved defaults-and-go — issue #19)
- **Date:** 2026-06-06
- **Context issue:** [#19](https://github.com/gagan114662/agent-skills/issues/19)
- **Builds on:** [ADR-0001](0001-stack.md), [ADR-0002](0002-data-model.md), [ADR-0003](0003-auth-identity.md), [ADR-0004](0004-channels-dms.md)

## Context
reload.chat is a multi-tenant SaaS run 24/7 by autonomous agents. Before more product
surface lands, the platform needs the operational floor: deploy the whole stack from one
pipeline, observe it, trace a single request, and **prove tenant A can never read tenant B**.

## Decisions

1. **Correlation ids via Fastify, not a new dependency.** `requestIdHeader: "x-request-id"`
   makes Fastify adopt an inbound id (propagation across services) and `genReqId` falls back
   to a uuidv7 — reusing the existing `newId()`. The id is stamped on every log line
   (`requestIdLogLabel: "requestId"`) and echoed in the `x-request-id` response header. W3C
   `traceparent` is echoed too, so an OTel exporter can adopt the seam later without touching
   routes. **No tracing SDK added now** — the propagation seam is the deliverable.

2. **Tenant-attributed logging by memoized identity.** A global `preHandler` resolves the
   caller once and binds `{ workspaceId, memberId, kind }` to the request log child, so every
   line is tenant-attributed. To avoid a second DB lookup (routes also resolve identity),
   `resolveIdentity` is **memoized per request via a `WeakMap`** keyed by the request object —
   chosen over `any`-typed request decoration (the lint config forbids `any`).

3. **Observability installed directly on the root app, not via `app.register`.** A registered
   Fastify plugin encapsulates its hooks to its own scope; sibling route plugins would be
   untouched. `registerObservability(app)` attaches the hooks + `/metrics` to the root so they
   apply to every route.

4. **Dependency-free Prometheus metrics registry.** Rather than pull `prom-client`, a small
   in-process registry renders the text exposition format: `http_requests_total`,
   `http_request_duration_seconds` (histogram), `http_requests_in_flight`, and process gauges.
   Keeps the runtime lean and the committed lockfile frozen. **Cardinality discipline:** series
   are labelled by the **route template** (`/channels/:cid/messages`), never the raw path, and
   **tenant id is NOT a metric label** (high-cardinality anti-pattern) — it lives in logs/traces.

5. **Three probe endpoints, all unauthenticated and tenant-data-free.** `/livez` (always 200 —
   restart probe), `/readyz` (200 ready / 503 not_ready — traffic gate, checks db+redis),
   `/healthz` (human summary, retained from #1). `/metrics` joins them. None read tenant data,
   so they are safe to expose to probes/scrapers without auth.

6. **Centralized tenant guard.** `auth/guard.ts` exposes `requireIdentity` (401) and
   `assertWorkspace` (403); the tenant-scoped routes adopt them so the #3 IDOR check can't be
   silently dropped. Behavior is identical to #4; the **cross-tenant leakage integration test**
   (workspace A → 403/404 on B's channels/messages, with a positive control) is the regression
   guard. `agents.ts` keeps its human-specific messages and is left as-is.

7. **Containerized deploy with migrate-on-deploy.** A multi-stage `Dockerfile` builds the
   workspace and ships a slim non-root runtime. `docker-entrypoint.sh` runs the compiled
   migrate CLI (`dist/db/migrate.js up` — no `tsx` at runtime) then `exec`s the server, so a
   single-container deploy self-migrates. In compose the same image splits into an ordered
   one-shot `migrate` service + long-running `server` (gated on `service_completed_successfully`
   and dependency health, with a `/readyz` healthcheck). The app stack sits behind a **`full`
   compose profile** so plain `docker compose up -d` still starts only infra — preserving the
   #1–#4 dev/demo workflow.

8. **SLOs/backups as code, not a hosted stack.** `observability/prometheus.yml` +
   `observability/alerts.yml` encode scrape config and SLO alert rules (availability 99.5%,
   p95 < 500ms, target-down). `scripts/backup.sh`/`restore.sh` script `pg_dump`/`psql` via the
   compose `postgres` service. Standing up managed Prometheus/Grafana/Alertmanager and offsite
   backup scheduling are environment concerns documented in `docs/operations.md`.

## Consequences
- The stack deploys from one command (`docker compose --profile full up -d --build`), migrates
  on deploy, and is healthy only once `/readyz` passes.
- Every request is traceable end-to-end by `x-request-id`, with tenant attribution on every log
  line; `/metrics` is scrapeable with bounded cardinality.
- Tenant isolation is locked by an integration test that fails if the workspace boundary regresses.

## Follow-ups (deferred)
- Drop-in OpenTelemetry exporter on the existing propagation seam.
- Prune dev dependencies from the runtime image (or `pnpm deploy`) to shrink it.
- Per-tenant rate limits / resource quotas.
- Provider-specific IaC (K8s/Terraform) and scheduled offsite backups.
- A unique `dm_key` index and other hardening noted in earlier ADRs.
