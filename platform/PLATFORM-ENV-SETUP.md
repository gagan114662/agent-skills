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
| **`ANTHROPIC_MODEL`** | **`claude-opus-4-8`** | Deployment-wide Claude model for the `claude-code` harness. It is not used as proof for the signed-in team-engine room. |
| `CODEX_BIN` | `codex` | Path/name of the Codex CLI (`codex` harness only). Public room launches are gated by `/me/codex/preflight` before this harness is selected. |
| `CODEX_MODEL` | — | Optional Codex CLI model flag. This is model selection only; it is not subscription-auth proof. |
| `RELOAD_KNOWN_MODELS` | — | Escape hatch: comma-separated model ids to allow alongside `KNOWN_AGENT_MODELS` without a code deploy (#246). |

**Default model:** the legacy Claude lane runs **`claude-opus-4-8`** when `claude-code` is selected.
A mis-set value is caught BEFORE spawn by the #246 launch preflight (`runtime/models.ts` →
`ModelUnavailableError`), surfaced as an actionable owner message + a self-heal incident (#242), never
an opaque "error · exit 1". This is set in three places that must stay in sync:

1. [`.env.example`](./.env.example) — local/dev default.
2. [`fly.toml`](./fly.toml) `[env]` — the live Fly default (`fly deploy` applies it).
3. This file — the human-facing reference.

A workspace owner can change the legacy Claude model without code via **Settings -> Connect Claude ->
Model** (validated against the models known to resolve); a per-session model selection (#52) still
overrides it.

**Team-engine room auth is fail-closed (#1282).** The signed-in iMessage/team room requests the
`codex` harness per subtask, but `/channels/:cid/team-runs` first checks `/me/codex/preflight`.
That preflight must prove:

- `selectedHarness: "codex"`
- `userAuthenticated: true`
- `workspaceAuthenticated: true`
- `runtimeAuth: "signed_in_subscription"`
- `fallback: "none"`
- `apiKeySatisfies: false`

Until a permitted signed-in Codex subscription bridge exists, the preflight returns
`runtimeAuth: "missing"` and the room launch is rejected before any agent session is created. OpenAI API
keys, Claude tokens, and the demo harness are deliberately not accepted as substitutes for this product
promise.

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
