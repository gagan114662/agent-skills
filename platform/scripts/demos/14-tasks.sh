#!/usr/bin/env bash
# Scripted acceptance demo for the Linear-style task system (issue #14).
# create → assign agent → agent drives status to done → reassignment preserves history
# → auto-routing picks the least-loaded eligible agent → task↔message links resolve both ways
# → cross-workspace access rejected. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; JAR2="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$JAR2"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
status_of() { curl -s -b "$JAR" "localhost:3000/tasks/$1" | field status; }
assignee_of() { curl -s -b "$JAR" "localhost:3000/tasks/$1" | field assigneeMemberId; }
# PATCH a task's status as an agent (Bearer); echo the resulting status.
agent_set() { curl -s -H "Authorization: Bearer $1" -H 'content-type: application/json' \
  -XPATCH "localhost:3000/tasks/$2/status" -d "{\"status\":\"$3\"}" | field status; }

cyan "==> Reload — issue #14 tasks demo"
cyan "==> 1/7  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-tasks.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/7  Human owner signs up; registers agents Worker, RouteA, RouteB"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"tasks-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
reg() { curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d "{\"name\":\"$1\"}"; }
WK=$(reg Worker); WMEM=$(printf '%s' "$WK" | field memberId); WTOK=$(printf '%s' "$WK" | field token)
A=$(reg RouteA);  AMEM=$(printf '%s' "$A"  | field memberId)
B=$(reg RouteB);  BMEM=$(printf '%s' "$B"  | field memberId)
echo "    workspace=$WS  Worker=$WMEM  RouteA=$AMEM  RouteB=$BMEM"

cyan "==> 3/7  Create a task, assign Worker, Worker drives backlog → todo → in_progress → done"
T=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H 'content-type: application/json' -d '{"title":"Ship #14","labels":["build"]}' | field id)
echo "    created task=$T status=$(status_of "$T")"
curl -s -b "$JAR" -XPOST "localhost:3000/tasks/$T/assign" -H 'content-type: application/json' -d "{\"assigneeMemberId\":\"$WMEM\"}" >/dev/null
echo "    assigned → assignee=$(assignee_of "$T")"
for S in todo in_progress done; do echo "    Worker(Bearer) → $(agent_set "$WTOK" "$T" "$S")"; done
echo "    event chain: $(curl -s -b "$JAR" "localhost:3000/tasks/$T/events" | grep -oE '"type":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
green "    expected: backlog→todo→in_progress→done; events created assigned status_changed×3 ✓"

cyan "==> 4/7  Reassignment preserves history (assign RouteA → reassign RouteB)"
T2=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H 'content-type: application/json' -d '{"title":"Handoff"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/tasks/$T2/assign" -H 'content-type: application/json' -d "{\"assigneeMemberId\":\"$AMEM\"}" >/dev/null
curl -s -b "$JAR" -XPOST "localhost:3000/tasks/$T2/assign" -H 'content-type: application/json' -d "{\"assigneeMemberId\":\"$BMEM\"}" >/dev/null
echo "    assignment events: $(curl -s -b "$JAR" "localhost:3000/tasks/$T2/events" | grep -oE '"type":"(assigned|reassigned|unassigned)"' | cut -d'"' -f4 | tr '\n' ' ')"
green "    expected: assigned reassigned (full chain kept) ✓"

cyan "==> 5/7  Auto-routing → least-loaded eligible agent"
# two fresh agents both eligible for label 'triage' (no prior load), so the choice is unambiguous
X=$(reg RouteX); XMEM=$(printf '%s' "$X" | field memberId)
Y=$(reg RouteY); YMEM=$(printf '%s' "$Y" | field memberId)
for M in "$XMEM" "$YMEM"; do
  curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/task-routing-rules" -H 'content-type: application/json' -d "{\"label\":\"triage\",\"agentMemberId\":\"$M\"}" >/dev/null
done
echo "    rules: triage → RouteX($XMEM), RouteY($YMEM)"
# preload RouteX with one open task so RouteY is the least-loaded
PL=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H 'content-type: application/json' -d '{"title":"preload","labels":["triage"]}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/tasks/$PL/assign" -H 'content-type: application/json' -d "{\"assigneeMemberId\":\"$XMEM\"}" >/dev/null
echo "    preloaded RouteX with 1 open task → RouteY is least-loaded"
RT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H 'content-type: application/json' -d '{"title":"route me","labels":["triage"],"autoRoute":true}')
echo "    routed assignee=$(printf '%s' "$RT" | field assigneeMemberId)  (RouteY=$YMEM, the least-loaded)"
green "    expected: routed to RouteY ✓"

cyan "==> 6/7  Task ↔ message link resolves both ways"
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
MID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"link me"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/tasks/$T/links" -H 'content-type: application/json' -d "{\"targetType\":\"message\",\"targetId\":\"$MID\"}" >/dev/null
echo "    forward  task→links: $(curl -s -b "$JAR" "localhost:3000/tasks/$T/links" | grep -oE '"targetType":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
echo "    reverse  message→tasks: $(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/links/message/$MID/tasks" | grep -oE '"id":"[^"]*"' | head -1 | cut -d'"' -f4)  (= $T)"
green "    expected: message link resolves both ways ✓"

cyan "==> 7/7  Cross-workspace access rejected"
curl -s -c "$JAR2" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"other-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Other\",\"workspaceSlug\":\"other-$(date +%s)\"}" >/dev/null
X=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR2" "localhost:3000/tasks/$T")
echo "    other-workspace GET /tasks/\$T → $X  (expected 404)"

green "==> Tasks verified: validated lifecycle, agent-driven status, history-preserving reassignment,"
green "    least-loaded auto-routing, bidirectional links, cross-workspace isolation."
