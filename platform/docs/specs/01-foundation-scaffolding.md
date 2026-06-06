# Spec: Reload Platform — Foundation Scaffolding (Issue #1)

> Implements [#1](https://github.com/gagan114662/agent-skills/issues/1). Phase 0 — Foundation.
> Lifecycle: this is the **DEFINE** artifact (`spec-driven-development`). No code until approved.

## Objective

**What:** Stand up the greenfield monorepo for **Reload** (a Slack-for-AI-agents platform, reload.chat-style) under `platform/`, with the technology stack locked, a runnable client+server skeleton, local infra via Docker Compose, and CI green on a fresh clone.

**Why:** Every later issue (#2–#19) builds on this skeleton. It is the strict serial root of the dependency graph — nothing else can start until it lands. It must establish the conventions (workspace layout, typed contracts, test harness, CI) that all feature work inherits.

**Who:** The engineers/agents who will implement #2–#19, and operators running it locally.

**Success looks like:** A teammate clones the repo, runs two commands, and has a server answering `GET /healthz` and a web app rendering — with CI proving it on every PR.

### Acceptance criteria (from #1, reframed as testable conditions)
- `pnpm install && pnpm dev` boots `apps/server` (Fastify) and `apps/web` (Vite) against Compose Postgres+Redis.
- `GET /healthz` returns `200` with `{ status: "ok", db: "up", redis: "up" }`; an automated test asserts this.
- CI (install → typecheck → lint → test → build) passes on a fresh clone with no manual steps.
- Stack decision is recorded as an ADR at `platform/docs/adrs/0001-stack.md`.

### Explicitly OUT of scope (deferred to later issues)
- Any product feature: channels, messages, auth, agents, tasks, memory (#2+).
- Real database tables / domain migrations (#2). This issue only proves DB **connectivity**.
- Deployment / hosting / multi-tenancy (#19). Local Compose only.
- Production observability stack (#19). Basic structured logging only.

## Tech Stack (locked here — see ADR-0001)

| Concern | Choice | Version (pinned at impl time) |
|---|---|---|
| Language | TypeScript (strict) | 5.x |
| Runtime | Node.js | 22 LTS |
| Package manager / monorepo | pnpm workspaces | 10.x |
| HTTP server | Fastify | 5.x |
| Realtime | `ws` (raw WebSocket) on the Fastify server | latest |
| DB | PostgreSQL + Drizzle ORM | pg 16 / drizzle latest |
| Cache / pub-sub / presence | Redis (`ioredis`) | redis 7 |
| Web client | React + Vite | React 19 / Vite 5 |
| Agent protocol (later) | `@modelcontextprotocol/sdk` | latest (added in #10, listed now for direction) |
| Tests | Vitest | latest |
| Lint / format | ESLint + Prettier | latest |
| Local infra | Docker Compose | — |

## Commands

```bash
# Install
pnpm install

# Dev (server + web concurrently; expects Compose infra up)
pnpm dev

# Local infra (Postgres + Redis)
docker compose up -d        # or: pnpm infra:up
docker compose down         #     pnpm infra:down

# Quality gates (each runnable in isolation; CI runs all)
pnpm typecheck              # tsc --noEmit across workspaces
pnpm lint                   # eslint .
pnpm format                 # prettier --write .
pnpm test                   # vitest run
pnpm build                  # build all workspaces
```

## Project Structure

```
platform/
  apps/
    server/                 → Fastify API + WebSocket gateway
      src/
        index.ts            → boot, env, graceful shutdown
        app.ts              → Fastify app factory (testable, no listen)
        routes/health.ts    → GET /healthz (checks db + redis)
        db/index.ts         → Drizzle + pg pool (connectivity only this issue)
        redis/index.ts      → ioredis client
      test/health.test.ts   → asserts /healthz contract
    web/                    → React + Vite client
      src/main.tsx, App.tsx → minimal shell that calls /healthz
  packages/
    shared/                 → cross-cutting TS types/contracts (e.g. HealthResponse)
      src/index.ts
  docs/
    specs/                  → one spec per issue (this file)
    adrs/                   → architecture decision records
  docker-compose.yml        → postgres + redis
  package.json, pnpm-workspace.yaml, tsconfig.base.json, .env.example
.github/workflows/platform-ci.yml   → CI for the platform/ workspace
```

> Note: `.github/` already exists at repo root for the skills library. The platform CI workflow is **added alongside** existing workflows, scoped via `paths: ['platform/**']`, and must not disturb skills-library CI.

## Code Style

TypeScript, strict mode, ES modules. Named exports. App factory split from `listen` so it's testable. Example:

```ts
// apps/server/src/app.ts
import Fastify, { type FastifyInstance } from 'fastify'
import { healthRoutes } from './routes/health.js'

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true })
  app.register(healthRoutes)
  return app
}

// apps/server/src/routes/health.ts
import type { FastifyInstance } from 'fastify'
import type { HealthResponse } from '@reload/shared'
import { pingDb } from '../db/index.js'
import { pingRedis } from '../redis/index.js'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async (): Promise<HealthResponse> => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()])
    return { status: db && redis ? 'ok' : 'degraded', db: db ? 'up' : 'down', redis: redis ? 'up' : 'down' }
  })
}
```

Conventions: `kebab-case` files, `camelCase` vars, `PascalCase` types/components. Prettier owns formatting (no debates). No `any` without an inline justification comment. Shared contracts live in `@reload/shared`, never duplicated.

## Testing Strategy

- **Framework:** Vitest. Tests colocated under each workspace's `test/` (`*.test.ts`).
- **This issue's tests:** `apps/server/test/health.test.ts` boots `buildApp()` via `app.inject()` (no network) and asserts the `/healthz` contract with the db/redis pings mocked (hermetic). Real db/redis **connectivity** is exercised by the demo (`scripts/demo.sh`, recorded as the PR video) against Docker Compose. A CI **service-container** integration job is intentionally **deferred to #2** (when schema/migrations land and there's something to integration-test); CI here runs the hermetic unit test only.
- **Levels:** unit (pure logic), integration (route + infra) here; e2e/browser deferred to feature issues (#18 uses `browser-testing-with-devtools`).
- **Coverage:** no hard % gate on the skeleton; gate is "the health contract test passes." Feature issues will set coverage expectations.
- **TDD:** per `test-driven-development`, the health test is written **before** the route implementation (red → green).

## Boundaries

- **Always:** keep `platform/` self-contained; run `pnpm typecheck && pnpm lint && pnpm test` before opening a PR; put shared types in `@reload/shared`; pin dependency versions; write the failing test first; **attach a demo video to every PR** (the SHIP gate Gagan reviews before approving).
- **Ask first:** adding any dependency beyond the locked stack; changing the stack decision (update ADR-0001 first); editing root-level repo config (`.github/`, root `README.md`, skills-library files); changing CI that affects the skills library.
- **Never:** commit secrets or a real `.env` (only `.env.example`); edit the vendored skills library (`skills/`, `agents/`, `references/`) as part of platform work; **merge any PR without Gagan's approval**; remove/skip failing tests to make CI green.

## Success Criteria
1. Fresh clone → `docker compose up -d && pnpm install && pnpm dev` → server on `:3000`, web on `:5173`.
2. `curl localhost:3000/healthz` → `200 {"status":"ok","db":"up","redis":"up"}`.
3. `pnpm test` green locally and in CI; `health.test.ts` present and asserting the contract.
4. `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass.
5. `platform/docs/adrs/0001-stack.md` committed and linked from the PR.
6. CI workflow runs on PRs touching `platform/**` and is green.
7. **Video proof:** the PR includes a demo video (committed at `platform/docs/demos/01-foundation-scaffolding.mp4`, playable inline in the PR) walking through criteria 1–4, and CI regenerates the same demo as a downloadable artifact. **Reusable mechanism** (`platform/scripts/record-demo.sh`) established here for all future issues.

## Open Questions (need your input before PLAN)
1. **Package scope name:** I'll use `@reload/*` (e.g. `@reload/shared`, `@reload/server`). OK, or prefer a different scope?
2. **Server port / web port:** defaulting to `3000` (API) and `5173` (Vite). Fine?
3. **Realtime lib:** raw `ws` vs `socket.io`. I lean **raw `ws`** (lighter, standard, fine for our protocol) — agree, or want `socket.io`'s reconnection/rooms sugar? (This only *scaffolds* the WS server in #1; full realtime is #5.)
4. **CI Postgres/Redis in CI:** use GitHub Actions **service containers** (recommended) — OK?
5. **Branch name** for the PR: `feat/01-foundation-scaffolding` off `main`. Good?
