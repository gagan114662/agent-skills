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
| **`ANTHROPIC_MODEL`** | **`claude-opus-4-8`** | **Deployment-wide default model.** The harness emits an env-gated `--model` flag (`${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}`, #52) that reads this. **MUST be a model the API actually serves** — a non-existent id makes every session exit 1 producing nothing (#242). A workspace's owner-picked model + a per-session #52 selection still override it. The #246 launch preflight rejects an unservable id BEFORE spawn. Empty ⇒ Claude Code's own default. |
| `RELOAD_KNOWN_MODELS` | — | Escape hatch: comma-separated model ids to allow alongside `KNOWN_AGENT_MODELS` without a code deploy (#246). |

**Default model:** the fleet runs **`claude-opus-4-8`** — the **owner decision** (#246), on the connected
Claude **subscription** token only (never an API key). A mis-set value is caught BEFORE spawn by the #246
launch preflight (`runtime/models.ts` → `ModelUnavailableError`), surfaced as an actionable owner message
+ a self-heal incident (#242), never an opaque "error · exit 1". This is set in three places that must
stay in sync:

1. [`.env.example`](./.env.example) — local/dev default.
2. [`fly.toml`](./fly.toml) `[env]` — the live Fly default (`fly deploy` applies it).
3. This file — the human-facing reference.

A workspace owner can change the fleet model without code via **Settings → Connect Claude → Model**
(validated against the models known to resolve); a per-session model selection (#52) still overrides it.

**Auth is subscription-only (#246).** Agent runs authenticate with the workspace's connected
`CLAUDE_CODE_OAUTH_TOKEN` (the `claude setup-token` in the per-tenant vault). There is **no
`ANTHROPIC_API_KEY` fallback** for agent runtime — a missing/expired token surfaces "reconnect your
Claude", never an API-key charge.

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
