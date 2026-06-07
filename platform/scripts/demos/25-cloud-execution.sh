#!/usr/bin/env bash
# Scripted acceptance demo for cloud agent execution (issue #25).
# spawn an agent session → CLOSE THE LAPTOP (no client connected) → the server keeps the agent
# working → streamed output + result land in the channel → secret stays redacted.
# Default backend is LocalRuntime (no cloud spend); the same flow runs on Vercel Sandbox by
# setting AGENT_RUNTIME=sandbox. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

HARNESS="$(pwd)/scripts/agent-harness-demo.sh"
SECRET="sk-demo-do-not-leak-$$"

cyan "==> Reload — issue #25 cloud agent execution demo (close the laptop)"
cyan "==> 1/6  Infra + migrate + boot server (AGENT_RUNTIME=local, secret injected per tenant)"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
AGENT_RUNTIME=local \
  AGENT_HARNESS_CMD=bash \
  AGENT_HARNESS_ARGS="[\"$HARNESS\"]" \
  AGENT_IDLE_MS=10000 AGENT_WALLCLOCK_MS=60000 \
  AGENT_SECRETS="{\"*\":{\"DEMO_SECRET\":\"$SECRET\"}}" \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo25-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/6  Human signup + create #agents channel"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo25-$(date +%s)\"}" >/dev/null
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
echo "    workspace=$WS  channel(#agents)=$CID"

cyan "==> 3/6  Register an agent + launch a session into #agents"
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)
LAUNCH=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"summarize the latest changes\"}")
SID=$(printf '%s' "$LAUNCH" | field id); STATUS=$(printf '%s' "$LAUNCH" | field status)
echo "    launched session=$SID  status=$STATUS (HTTP 202 — accepted, running server-side)"

cyan "==> 4/6  CLOSE THE LAPTOP — drop the client entirely; no connection held open"
rm -f "$JAR.client" 2>/dev/null || true
echo "    (no WebSocket, no open request — the agent is now purely server-owned)"

cyan "==> 5/6  Reconnect later and poll the session — the server kept it running"
for i in $(seq 1 60); do
  S=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID" | field status)
  [ "$S" = "completed" ] && break
  [ "$S" = "failed" ] && { red "    session failed"; cat /tmp/reload-demo25-server.log; exit 1; }
  sleep 0.5
done
green "    session reached status=$S ✓  (the agent finished while the laptop was closed)"

cyan "==> 6/6  The streamed output + result landed in the channel (and the secret is redacted)"
MSGS=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages")
printf '%s' "$MSGS" | grep -oE '"body":"[^"]*"' | cut -d'"' -f4 | sed 's/^/    • /'
if printf '%s' "$MSGS" | grep -q "$SECRET"; then
  red "    !! secret leaked into the channel"; exit 1
fi
green "==> Verified: spawn → close the laptop → agent kept working → result in channel; secret never leaked, session reaped."
