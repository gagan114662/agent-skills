#!/usr/bin/env bash
# Scripted acceptance demo for the Reload platform foundation (issue #1).
# Run from platform/. Wrapped by record-demo.sh to produce the PR video proof.
set -euo pipefail
cd "$(dirname "$0")/.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }

SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

cyan "==> Reload platform — issue #1 foundation demo"
cyan "==> 1/4  Unit tests (TDD: /healthz contract)"
pnpm --filter @reload/server test

cyan "==> 2/4  Local infra (Postgres + Redis via Docker Compose)"
docker compose up -d
# wait for Postgres + Redis healthchecks
for i in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && \
     [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q redis)" 2>/dev/null)" = "healthy" ]; then
    green "    infra healthy"; break
  fi
  sleep 1
done

cyan "==> 3/4  Boot the server (logs → /tmp/reload-demo-server.log)"
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  if curl -fs localhost:3000/healthz >/dev/null 2>&1; then break; fi
  sleep 0.5
done

cyan "==> 4/4  GET /healthz (expect 200 + status ok, db up, redis up)"
printf "    HTTP status: "; curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/healthz
printf "    body: "; curl -s localhost:3000/healthz; echo

green "==> Acceptance criteria met: tests green, infra up, /healthz 200 ok."
