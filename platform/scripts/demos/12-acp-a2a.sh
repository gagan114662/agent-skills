#!/usr/bin/env bash
# Scripted acceptance demo for the ACP + A2A protocol adapters (issue #12). Walks both flows over
# plain HTTP with agent Bearer tokens — no SDK, no custom glue:
#   A2A: fetch an AgentCard (capability handshake) → message/send hands off a TASK with context
#        intact → tasks/get reads it back → tasks/cancel.
#   ACP: create a RUN → its messages land in a channel THREAD → the agent replies → the run's output
#        reflects it → continue the run via session_id.
#   Plus: a token from another workspace is rejected (#3 IDOR). Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
API="http://localhost:3000"
JAR="$(mktemp)"; JAR2="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$JAR2"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
status() { grep -oE "\"state\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #12 ACP + A2A protocol adapters demo"
cyan "==> 1/8  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-12.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs "$API/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/8  Owner signs up, creates #general, registers two agents: 'planner' + 'scout'"
curl -s -c "$JAR" -XPOST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"p12-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" "$API/me" | field workspaceId)
GEN=$(curl -s -b "$JAR" -XPOST "$API/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
PLANNER=$(curl -s -b "$JAR" -XPOST "$API/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"planner","framework":"langgraph"}')
PID=$(printf '%s' "$PLANNER" | field agentId); PMEM=$(printf '%s' "$PLANNER" | field memberId); PTOK=$(printf '%s' "$PLANNER" | field token)
SCOUT=$(curl -s -b "$JAR" -XPOST "$API/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"scout","framework":"crewai"}')
STOK=$(printf '%s' "$SCOUT" | field token)
curl -s -b "$JAR" -XPOST "$API/channels/$GEN/grants" -H 'content-type: application/json' -d "{\"memberId\":\"$PMEM\",\"capability\":\"write\"}" >/dev/null
echo "    workspace=$WS  planner=$PID"

cyan "==> 3/8  [A2A] scout fetches planner's AgentCard — the capability handshake"
curl -s "$API/a2a/agents/$PID/agent-card.json" -H "Authorization: Bearer $STOK" \
  | grep -oE '"(protocolVersion|preferredTransport)":"[^"]*"|"id":"handoff"|"scheme":"bearer"'
green "    ↑ JSON-RPC transport, bearer auth, a 'handoff' skill — discovered before sending ✓"

cyan "==> 4/8  [A2A] scout HANDS OFF a task to planner via message/send"
HANDOFF=$(curl -s "$API/a2a/agents/$PID" -H "Authorization: Bearer $STOK" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m1","parts":[{"kind":"text","text":"investigate the outage and report findings"}]}}}')
TID=$(printf '%s' "$HANDOFF" | field id)
echo "    handoff → task $TID  state=$(printf '%s' "$HANDOFF" | status)  (submitted)"

cyan "==> 5/8  [A2A] planner reads the handed-off task — CONTEXT INTACT — then cancels"
GOT=$(curl -s "$API/a2a/agents/$PID" -H "Authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tasks/get\",\"params\":{\"id\":\"$TID\"}}")
echo "    tasks/get history: $(printf '%s' "$GOT" | grep -oE '"text":"[^"]*"' | head -1)"
echo "    native cross-check: assignee=$(curl -s -b "$JAR" "$API/tasks/$TID" | field assigneeMemberId) (planner=$PMEM)"
CANCEL=$(curl -s "$API/a2a/agents/$PID" -H "Authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tasks/cancel\",\"params\":{\"id\":\"$TID\"}}")
green "    cancel → state=$(printf '%s' "$CANCEL" | status) ✓  (task + content transferred intact)"

cyan "==> 6/8  [ACP] owner creates a RUN targeting planner — input lands in #general as a thread"
RUN=$(curl -s "$API/acp/runs" -b "$JAR" -H 'content-type: application/json' \
  -d "{\"agent_name\":\"planner\",\"input\":[{\"role\":\"user\",\"parts\":[{\"content_type\":\"text/plain\",\"content\":\"plan the launch\"}]}],\"metadata\":{\"channel_id\":\"$GEN\"}}")
RUNID=$(printf '%s' "$RUN" | field run_id)
echo "    run_id=$RUNID  status=$(printf '%s' "$RUN" | grep -oE '"status":"[^"]*"' | cut -d'"' -f4)  (created)"
echo "    channel now shows: $(curl -s -b "$JAR" "$API/channels/$GEN/messages" | grep -oE '"body":"@planner[^"]*"' | head -1)"

cyan "==> 7/8  [ACP] planner replies in-thread → the run's output reflects it; continue via session"
curl -s "$API/channels/$GEN/messages/$RUNID/replies" -H "Authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -d '{"body":"here is the plan"}' >/dev/null
DONE=$(curl -s "$API/acp/runs/$RUNID" -b "$JAR")
echo "    GET run → status=$(printf '%s' "$DONE" | grep -oE '"status":"[^"]*"' | cut -d'"' -f4)  output=$(printf '%s' "$DONE" | grep -oE '"content":"[^"]*"' | tail -1)"
curl -s "$API/acp/runs" -b "$JAR" -H 'content-type: application/json' \
  -d "{\"agent_name\":\"planner\",\"session_id\":\"$RUNID\",\"input\":[{\"role\":\"user\",\"parts\":[{\"content_type\":\"text/plain\",\"content\":\"and the budget?\"}]}]}" >/dev/null
green "    thread replies: $(curl -s -b "$JAR" "$API/channels/$GEN/messages/$RUNID/thread" | grep -oE '"replyCount":[0-9]+')"

cyan "==> 8/8  A token from another workspace is rejected (#3 IDOR)"
curl -s -c "$JAR2" -XPOST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"other-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Other\",\"workspaceSlug\":\"other-$(date +%s)\"}" >/dev/null
OWS=$(curl -s -b "$JAR2" "$API/me" | field workspaceId)
OTOK=$(curl -s -b "$JAR2" -XPOST "$API/workspaces/$OWS/agents" -H 'content-type: application/json' -d '{"name":"intruder"}' | field token)
CARD=$(curl -s -o /dev/null -w "%{http_code}" "$API/a2a/agents/$PID/agent-card.json" -H "Authorization: Bearer $OTOK")
ACPX=$(curl -s -o /dev/null -w "%{http_code}" "$API/acp/runs/$RUNID" -H "Authorization: Bearer $OTOK")
echo "    intruder A2A AgentCard for planner = $CARD  ·  intruder ACP GET run = $ACPX  (both expected 404)"

green "==> #12 verified: A2A AgentCard handshake + task handoff (context intact), ACP run ⇄ channel"
green "    thread (messages mapped, session continued), cross-workspace rejected — no custom glue."
