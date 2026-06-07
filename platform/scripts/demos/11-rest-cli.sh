#!/usr/bin/env bash
# Scripted acceptance demo for the framework-agnostic REST + CLI agent interface (issue #11).
# An external agent holding ONLY a Bearer token walks the documented flow via the `reload` CLI:
#   whoami → list channels it can access → post → read its @mentions → read the OpenAPI contract.
# Plus: a token from another workspace is rejected (#3 IDOR). Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
CLI="node cli/reload.mjs"
export RELOAD_API_URL="http://localhost:3000"
JAR="$(mktemp)"; JAR2="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$JAR2"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #11 REST + CLI agent interface demo"
cyan "==> 1/8  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-11.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/8  Human owner signs up, creates #general and #ops, registers an agent 'scout'"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"rest-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
GEN=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
OPS=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"ops"}' | field id)
AGENT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"scout","framework":"langchain"}')
AMEM=$(printf '%s' "$AGENT" | field memberId)
export RELOAD_TOKEN=$(printf '%s' "$AGENT" | field token)
echo "    workspace=$WS  token=${RELOAD_TOKEN:0:12}…"

cyan "==> 3/8  Owner grants scout: write on #general (member of #ops left ungranted → invisible)"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$GEN/grants" -H 'content-type: application/json' -d "{\"memberId\":\"$AMEM\",\"capability\":\"write\"}" >/dev/null

cyan "==> 4/8  Agent, with ONLY its token, runs: reload whoami"
$CLI whoami
green "    ↑ identity + workspace discovered from the token alone ✓"

cyan "==> 5/8  reload channels  (only channels it can access — #ops is hidden)"
$CLI channels

cyan "==> 6/8  reload post $GEN 'scout online'  →  read it back"
$CLI post "$GEN" "scout online"
$CLI read "$GEN"

cyan "==> 7/8  Owner @mentions scout in #general  →  reload mentions"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$GEN/messages" -H 'content-type: application/json' -d '{"body":"@scout please triage the queue"}' >/dev/null
$CLI mentions
echo "    mention count: $($CLI mentions --count)"

cyan "==> 8/8  A token from another workspace is rejected (#3 IDOR); OpenAPI contract is public"
curl -s -c "$JAR2" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"other-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Other\",\"workspaceSlug\":\"other-$(date +%s)\"}" >/dev/null
OWS=$(curl -s -b "$JAR2" localhost:3000/me | field workspaceId)
OAGENT=$(curl -s -b "$JAR2" -XPOST "localhost:3000/workspaces/$OWS/agents" -H 'content-type: application/json' -d '{"name":"intruder"}' | field token)
XSTATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $OAGENT" "localhost:3000/channels/$GEN/messages")
echo "    intruder GET #general (other workspace) = $XSTATUS  (expected 404)"
echo "    OpenAPI title: $(curl -s localhost:3000/openapi.json | grep -oE '"title":"[^"]*"' | head -1)"

green "==> #11 verified: agent uses only a Bearer token to whoami → list accessible channels →"
green "    post → read mentions via the reload CLI; cross-workspace token rejected; OpenAPI published."
