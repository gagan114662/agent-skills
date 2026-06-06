#!/usr/bin/env bash
# Scripted acceptance demo for the Reload data model (issue #2).
# Run from platform/. Wrapped by record-demo.sh to produce the PR video proof.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }

cyan "==> Reload platform — issue #2 data model demo"

cyan "==> 1/5  Local infra (Postgres + Redis)"
docker compose up -d
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] \
    && { green "    postgres healthy"; break; }; sleep 1
done

cyan "==> 2/5  Migrate UP (create schema)"
pnpm --filter @reload/server db:migrate

cyan "==> 3/5  Seed demo workspace (1 human + 1 agent + 1 channel + message)"
pnpm --filter @reload/server db:seed

cyan "==> 4/5  Integration tests against real Postgres (round-trip, threads, soft-delete, CHECK, cascade)"
pnpm --filter @reload/server test:integration 2>&1 | tail -8

cyan "==> 5/5  Rollback (down) then re-migrate (up) — proving up/down clean"
pnpm --filter @reload/server db:rollback
pnpm --filter @reload/server db:migrate

green "==> Acceptance met: schema migrates up/down, seed + typed repositories verified on real Postgres."
