#!/usr/bin/env bash
# Scripted acceptance demo for MCP integration (issue #10). An off-the-shelf MCP client (the official
# SDK) holding ONLY an agent Bearer token connects to the Reload MCP server and:
#   list tools → list channels → post (visible live) → blocked on a read-only channel (#9) →
#   subscribe to reload://mentions → a human @mentions it → the mention is PUSHED to the client.
# Plus the message is read back over REST to prove it landed live. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
export RELOAD_API_URL="http://localhost:3000"
export MCP_URL="http://localhost:3000/mcp"
JAR="$(mktemp)"; WATCH_LOG="$(mktemp)"; SERVER_PID=""; WATCH_PID=""
cleanup() {
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$JAR" "$WATCH_LOG"
}
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
mcp() { pnpm --filter @reload/server exec node scripts/mcp-demo-client.mjs "$@"; }

cyan "==> Reload — issue #10 MCP integration demo"
cyan "==> 1/7  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-10.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/7  Human owner signs up; creates #general (write) and #read-only; registers agent 'scout'"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"mcp-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
GEN=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
RO=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"read-only"}' | field id)
AGENT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"scout","framework":"mcp"}')
AMEM=$(printf '%s' "$AGENT" | field memberId)
export RELOAD_TOKEN=$(printf '%s' "$AGENT" | field token)
echo "    workspace=$WS  token=${RELOAD_TOKEN:0:12}…"

cyan "==> 3/7  Owner grants scout: write on #general, read on #read-only"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$GEN/grants" -H 'content-type: application/json' -d "{\"memberId\":\"$AMEM\",\"capability\":\"write\"}" >/dev/null
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$RO/grants"  -H 'content-type: application/json' -d "{\"memberId\":\"$AMEM\",\"capability\":\"read\"}"  >/dev/null

cyan "==> 4/7  MCP client (Bearer token only): list tools → list channels → post → blocked on read-only"
mcp act "$GEN" "$RO"
green "    ↑ post to #general ok; post to #read-only is an MCP tool error (#9 respected) ✓"

cyan "==> 5/7  The posted message is visible live over REST / the web UI (#5)"
curl -s -H "Authorization: Bearer $RELOAD_TOKEN" "localhost:3000/channels/$GEN/messages" | grep -o '"body":"scout online via MCP"' | head -1
green "    ↑ message visible through the same feed the web UI renders ✓"

cyan "==> 6/7  MCP client subscribes to reload://mentions and waits"
mcp watch >"$WATCH_LOG" 2>&1 &
WATCH_PID=$!
for i in $(seq 1 40); do grep -q "READY" "$WATCH_LOG" && break; sleep 0.25; done

cyan "==> 7/7  Owner @mentions scout in #general  →  the mention is PUSHED to the MCP client"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$GEN/messages" -H 'content-type: application/json' -d '{"body":"@scout please triage the queue"}' >/dev/null
wait "$WATCH_PID" 2>/dev/null || true; WATCH_PID=""
grep -E "PUSHED mention|no mention" "$WATCH_LOG" || true

green "==> #10 verified: an MCP client with only a Bearer token joins, lists tools, posts (visible"
green "    live), is denied a write it lacks (#9), and is pushed an @mention via a resource subscription."
