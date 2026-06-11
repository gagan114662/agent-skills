# Platform Environment Setup

Reference for the environment variables that configure the `@reload/server` API
(`platform/apps/server`). Local defaults live in [`.env.example`](./.env.example); the live Fly
deployment's non-secret env lives in [`fly.toml`](./fly.toml) `[env]`; secrets are set with
`fly secrets set` and are never committed.

## Agent harness & model

| Var | Default | Purpose |
| --- | --- | --- |
| `AGENT_HARNESS` | `demo` | Which harness runs per session (`demo` \| `claude-code` \| `codex`). `demo` spends nothing. |
| `AGENT_RUNTIME` | `local` | Where sessions execute (`local` \| `sandbox`). |
| `CLAUDE_BIN` | `claude` | Path/name of the Claude Code binary (`claude-code` harness only). |
| **`ANTHROPIC_MODEL`** | **`claude-fable-5`** | **Deployment-wide default model.** The harness emits an env-gated `--model` flag (`${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}`, #52) that reads this. Empty ⇒ Claude Code's own default. |

**Owner directive:** live ipop agents default to **`claude-fable-5`**. This is set in three places that
must stay in sync:

1. [`.env.example`](./.env.example) — local/dev default.
2. [`fly.toml`](./fly.toml) `[env]` — the live Fly default (`fly deploy` applies it).
3. This file — the human-facing reference.

Per-session model selection (#52) still overrides the default via the merged session env, so a
workspace can pin a different model without changing the deployment default.

## Profiles

| Var | Default | Purpose |
| --- | --- | --- |
| `RELOAD_PROFILE` | `dev` | `dev` (local/demo) or `prod` (secret-free preflight + launch gate, #69). |
| `NODE_ENV` | — | `production` on Fly. |
| `PORT` | `8080` | HTTP listen port. |

## Data stores & web origin

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://reload:reload@localhost:5433/reload` | Postgres connection (secret on Fly). |
| `REDIS_URL` | — | Redis connection for maintenance flag / realtime (secret on Fly). |
| `RELOAD_WEB_ORIGIN` | — | CORS allowlist for the Vercel console (#108). |

## Operational loops (opt-in, default OFF)

Background supervisor loops are off until their interval is set non-zero:

| Var | Default | Purpose |
| --- | --- | --- |
| `WATCHDOG_INTERVAL_MS` | `0` | Fleet watchdog tick interval (#105). |

See [`.env.example`](./.env.example) for the full annotated list.
