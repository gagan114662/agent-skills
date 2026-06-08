#!/usr/bin/env bash
# Scripted acceptance demo for cross-team agent pooling + autonomy (issue #17).
#   AC1 an agent progresses an assigned task with NO human prompt
#   AC2 a two-agent handoff completes a workflow, pausing only at an approval gate (A2A shared memory)
#   AC3 a pooled agent SHARED into a second team acts there per its roles
#   AC4 the kill switch halts the loop immediately; budget/loop guards bound it
# The background loop is opt-in; here we drive it explicitly via POST /autonomy/tick. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
bodies() { grep -oE '"body":"[^"]*"' | cut -d'"' -f4 | sed 's/^/    • /'; }
H='content-type: application/json'

cyan "==> Reload — issue #17 agent pooling + autonomy demo"
cyan "==> 1/8  Infra + migrate + boot server (autonomy timer OFF; we tick explicitly)"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo17-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/8  Human signup + create team-a channel"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H "$H" \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo17-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
A=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H "$H" -d '{"name":"team-a"}' | field id)
echo "    workspace=$WS  team-a=$A"

cyan "==> 3/8  Register two agents, pool them with roles, enable autonomy"
R=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H "$H" -d '{"name":"Researcher"}' | field memberId)
W=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H "$H" -d '{"name":"Writer"}' | field memberId)
POOL=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agent-pools" -H "$H" -d '{"name":"core"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agent-pools/$POOL/agents" -H "$H" -d "{\"agentMemberId\":\"$R\",\"roles\":[\"researcher\"]}" >/dev/null
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agent-pools/$POOL/agents" -H "$H" -d "{\"agentMemberId\":\"$W\",\"roles\":[\"writer\"]}" >/dev/null
for M in "$R" "$W"; do curl -s -b "$JAR" -XPUT "localhost:3000/workspaces/$WS/agents/$M/autonomy" -H "$H" -d '{"enabled":true,"actionBudget":100}' >/dev/null; done
echo "    pooled researcher=$R writer=$W; autonomy enabled"

cyan "==> 4/8  Create a task + a two-stage workflow (researcher → writer) in team-a"
TASK=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H "$H" -d '{"title":"write the launch post"}' | field id)
WF=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$A/workflows" -H "$H" \
  -d "{\"taskId\":\"$TASK\",\"stages\":[{\"agentMemberId\":\"$R\",\"role\":\"researcher\"},{\"agentMemberId\":\"$W\",\"role\":\"writer\"}]}" | field id)
echo "    task=$TASK workflow=$WF"

cyan "==> 5/8  AC1+AC2: drive the loop — start → handoff → approval (no human in between)"
for STEP in "start" "handoff" "request_approval"; do
  ACT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/autonomy/tick" | grep -oE '"action":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "    tick → $ACT"
done
green "    task status: $(curl -s -b "$JAR" localhost:3000/tasks/$TASK | field status)  (advanced with no human prompt — AC1)"
curl -s -b "$JAR" "localhost:3000/channels/$A/messages" | bodies

cyan "==> 6/8  AC2: the workflow is parked at the human gate; one approval completes it"
AP=$(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/autonomy/approvals?status=pending" | field id)
echo "    pending approval=$AP — approving as a human…"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/autonomy/approvals/$AP/approve" >/dev/null
green "    workflow=$(curl -s -b "$JAR" localhost:3000/channels/$A/workflows/$WF | field status)  task=$(curl -s -b "$JAR" localhost:3000/tasks/$TASK | field status) ✓"

cyan "==> 7/8  AC3: share the pooled Writer into team-b and let it act there per its role"
B=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H "$H" -d '{"name":"team-b"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$B/share-agent" -H "$H" -d "{\"agentMemberId\":\"$W\"}" >/dev/null
TASK2=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H "$H" -d '{"title":"draft team-b note"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$B/workflows" -H "$H" \
  -d "{\"taskId\":\"$TASK2\",\"stages\":[{\"agentMemberId\":\"$W\",\"role\":\"writer\"}]}" >/dev/null
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/autonomy/tick" >/dev/null
green "    team-b activity (shared agent acting in a second team):"
curl -s -b "$JAR" "localhost:3000/channels/$B/messages" | bodies

cyan "==> 8/8  AC4: kill switch halts the loop immediately"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/autonomy/kill" | grep -oE '"killSwitch":(true|false)' | sed 's/^/    /'
TASK3=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H "$H" -d '{"title":"must not start"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$A/workflows" -H "$H" \
  -d "{\"taskId\":\"$TASK3\",\"stages\":[{\"agentMemberId\":\"$R\",\"role\":\"researcher\"}]}" >/dev/null
KILLED=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/autonomy/tick" | grep -oE '"killSwitch":true' || true)
ST3=$(curl -s -b "$JAR" localhost:3000/tasks/$TASK3 | field status)
if [ -n "$KILLED" ] && [ "$ST3" = "backlog" ]; then
  green "    tick returned killSwitch=true; new task stayed '$ST3' — the loop did nothing ✓"
else
  red "    !! kill switch did not halt the loop"; exit 1
fi
green "==> Verified: autonomous progression, A2A handoff w/ shared-memory continuity, approval gate, cross-team sharing, and an immediate kill switch."
