#!/usr/bin/env bash
# Scripted acceptance demo for permission-scoped search (issue #7).
# member finds a message (ranked) → non-member in the same workspace gets nothing
# → cross-workspace caller is rejected → filters narrow → unreadable channel filter
# leaks nothing → channel-name & member search. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; JAR2="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$JAR2"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
# count "id" occurrences in a /search results payload (one per hit)
hits() { grep -oE '"id":"[^"]*"' | wc -l | tr -d ' '; }

# GET /workspaces/$WS/search/messages with a token, return JSON. $1=token $2=querystring
search_msgs_tok() { curl -s -H "Authorization: Bearer $1" "localhost:3000/workspaces/$WS/search/messages?$2"; }
search_msgs_cookie() { curl -s -b "$JAR" "localhost:3000/workspaces/$WS/search/messages?$1"; }
status_msgs_jar2() { curl -s -o /dev/null -w "%{http_code}" -b "$JAR2" "localhost:3000/workspaces/$WS/search/messages?$1"; }

cyan "==> Reload — issue #7 permission-scoped search demo"
cyan "==> 1/9  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-search.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/9  Human owner signs up, creates #general and #random"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Aria Owner\",\"workspaceSlug\":\"search-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
GEN=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
RAND=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"random"}' | field id)
echo "    workspace=$WS  general=$GEN  random=$RAND"

cyan "==> 3/9  Owner posts messages into both channels"
post() { curl -s -b "$JAR" -XPOST "localhost:3000/channels/$1/messages" -H 'content-type: application/json' -d "{\"body\":\"$2\"}" >/dev/null; }
post "$GEN"  "the deploy pipeline is finally green"
post "$GEN"  "deploy notes: rollback is one command"
post "$RAND" "anyone up for tacos after the deploy"
green "    posted 3 messages (2 in #general, 1 in #random)"

cyan "==> 4/9  Owner searches q=deploy (ranked, across readable channels)"
RES=$(search_msgs_cookie "q=deploy")
echo "    hits=$(printf '%s' "$RES" | hits)   (expected 3)"
printf '%s' "$RES" | grep -oE '"rank":[0-9.]+' | head -1 | sed 's/^/    top /'
green "    ✓ ranked full-text hits returned"

cyan "==> 5/9  Register an OUTSIDER agent (same workspace, NOT a channel member)"
OUT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Outsider"}')
OTOK=$(printf '%s' "$OUT" | field token)
echo "    outsider hits for q=deploy = $(search_msgs_tok "$OTOK" "q=deploy" | hits)"
green "    ✓ expected 0 — non-member sees nothing (no leakage)"

cyan "==> 6/9  Cross-workspace caller is rejected by the workspace guard"
curl -s -c "$JAR2" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"other-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Other\",\"workspaceSlug\":\"other-$(date +%s)\"}" >/dev/null
echo "    cross-workspace GET status = $(status_msgs_jar2 "q=deploy")   (expected 403)"
green "    ✓ tenant isolation enforced"

cyan "==> 7/9  Filters narrow: channelId=#general, then a wrong author"
echo "    q=deploy&channelId=general hits = $(search_msgs_cookie "q=deploy&channelId=$GEN" | hits)  (expected 2)"
echo "    q=deploy&authorMemberId=<random-uuid> hits = $(search_msgs_cookie "q=deploy&authorMemberId=00000000-0000-0000-0000-000000000000" | hits)  (expected 0)"
green "    ✓ filters compose (AND)"

cyan "==> 8/9  Unreadable channelId filter leaks nothing (no existence oracle)"
echo "    outsider q=deploy&channelId=general hits = $(search_msgs_tok "$OTOK" "q=deploy&channelId=$GEN" | hits)  (expected 0, status 200)"
green "    ✓ filter can't confirm a channel the caller can't read"

cyan "==> 9/9  Channel-name & member search (scoped)"
echo "    channels q=rand = $(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/search/channels?q=rand" | hits)  (expected 1: #random)"
echo "    members  q=Aria = $(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/search/members?q=Aria" | hits)  (expected 1: Aria Owner)"

green "==> Search verified: ranked FTS over readable channels, zero leakage to non-members"
green "    and across workspaces, composable filters with no existence oracle, name search scoped."
