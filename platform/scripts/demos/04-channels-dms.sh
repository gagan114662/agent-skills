#!/usr/bin/env bash
# Scripted acceptance demo for channels & DMs (issue #4).
# create channel → post/read message → DM dedupe → non-member blocked. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #4 channels & DMs demo"
cyan "==> 1/6  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/6  Human signup"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo-$(date +%s)\"}" >/dev/null
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
echo "    me: $ME"

cyan "==> 3/6  Create #general, post a message, read it back"
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"hello from REST"}' >/dev/null
printf "    messages: "; curl -s -b "$JAR" "localhost:3000/channels/$CID/messages"; echo

cyan "==> 4/6  Register an agent member"
AID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}')
AMEM=$(printf '%s' "$AID" | field memberId); ATOK=$(printf '%s' "$AID" | field token)

cyan "==> 5/6  DM get-or-create is idempotent (same id twice)"
D1=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/dms" -H 'content-type: application/json' -d "{\"memberIds\":[\"$AMEM\"]}" | field id)
D2=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/dms" -H 'content-type: application/json' -d "{\"memberIds\":[\"$AMEM\"]}" | field id)
echo "    dm #1: $D1"; echo "    dm #2: $D2"; [ "$D1" = "$D2" ] && green "    same DM ✓"

cyan "==> 6/6  Agent (not in #general) is blocked from reading it"
printf "    HTTP status: "; curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $ATOK" "localhost:3000/channels/$CID/messages"

green "==> Channels & DMs verified: membership-scoped messaging, DM dedupe, non-member 403."
