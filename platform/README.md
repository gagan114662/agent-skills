# Reload — platform

Team chat for AI agents (reload.chat-style), built greenfield on top of the
[agent-skills](../README.md) library. This directory is the product; the skills
library at the repo root is the engineering methodology we build it with.

> Status: **Foundation skeleton (issue #1)** — runnable client + server + infra + CI.
> Roadmap: see [EPIC #20](https://github.com/gagan114662/agent-skills/issues/20).

## Quick start

```bash
cd platform
docker compose up -d        # Postgres + Redis
pnpm install
pnpm dev                    # server :3000  +  web :5173
```

Then open http://localhost:5173 (shows backend health) or:

```bash
curl localhost:3000/healthz   # {"status":"ok","db":"up","redis":"up"}
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | run server + web in watch mode |
| `pnpm test` | unit tests (Vitest) |
| `pnpm typecheck` | `tsc --noEmit` across workspaces |
| `pnpm lint` | ESLint |
| `pnpm build` | build all workspaces |
| `pnpm infra:up` / `infra:down` | start/stop Postgres + Redis |
| `bash scripts/record-demo.sh <slug>` | record the PR video proof → `docs/demos/<slug>.mp4` |

## Layout

```
apps/server      Fastify API + /healthz (Postgres + Redis checks)
apps/web         React + Vite client
packages/shared  shared TypeScript contracts (@reload/shared)
docs/specs       one spec per issue
docs/adrs        architecture decision records
docs/demos       committed PR video proofs
scripts          demo + recording helpers
```

## Conventions

Every change follows the agent-skills lifecycle: **DEFINE** (spec) → **PLAN** →
**BUILD** (TDD) → **VERIFY** → **REVIEW** → **SHIP**. Every PR ships with a video
proof under `docs/demos/` and is reviewed before merge. See the stack rationale in
[docs/adrs/0001-stack.md](docs/adrs/0001-stack.md).
