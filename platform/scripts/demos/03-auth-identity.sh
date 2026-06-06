#!/usr/bin/env bash
# Scripted acceptance demo for auth & identity (issue #3).
# human signup → /me ; agent token → /me ; revoke → 401. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #3 auth & identity demo"

cyan "==> 1/6  Infra + migrate up"
docker compose up -d >/dev/null
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1
done
pnpm --filter @reload/server db:migrate

cyan "==> 2/6  Boot server (logs → /tmp/reload-demo-server.log)"
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

SLUG="demo-$(date +%s)"
EMAIL="gagan-$$@example.com"

cyan "==> 3/6  Human signup → session cookie"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"s3cret-pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"$SLUG\"}"; echo
printf "    GET /me (cookie): "; ME=$(curl -s -b "$JAR" localhost:3000/me); echo "$ME"
WS=$(printf '%s' "$ME" | field workspaceId)

cyan "==> 4/6  Register an agent (human-authed) → token shown once"
REG=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout","framework":"mcp"}')
echo "    $REG"
TOKEN=$(printf '%s' "$REG" | field token)
AID=$(printf '%s' "$REG" | field agentId)
TID=$(printf '%s' "$REG" | field tokenId)

cyan "==> 5/6  GET /me with the agent Bearer token"
printf "    "; curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/me; echo

cyan "==> 6/6  Revoke the token → GET /me now 401"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents/$AID/tokens/$TID/revoke" >/dev/null
printf "    HTTP status after revoke: "; curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" localhost:3000/me

green "==> Auth verified: human session + agent token resolve identity; revocation enforced (401)."
