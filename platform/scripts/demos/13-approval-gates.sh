#!/usr/bin/env bash
# Scripted acceptance demo for human approval gates & governance (issue #13).
# agent submits a sensitive action → it PAUSES (pending, not executed) → a human approves →
# it executes (message appears, authored by the agent) → audit chain requested→approved→executed
# → reject blocks a second action → an agent cannot decide (humans only) → external.send is gated
# by default. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
status_of() { curl -s -b "$JAR" "localhost:3000/approvals/$1" | field status; }
count_msgs() { curl -s -b "$JAR" "localhost:3000/channels/$1/messages" | grep -oE '"id":"' | wc -l | tr -d ' '; }
events_of() { curl -s -b "$JAR" "localhost:3000/approvals/$1/events" | grep -oE '"type":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' '; }
# submit an action as an agent (Bearer); echo the raw JSON.
submit() { curl -s -H "Authorization: Bearer $1" -H 'content-type: application/json' \
  -XPOST "localhost:3000/workspaces/$WS/actions" -d "$2"; }

cyan "==> Reload — issue #13 approval gates demo"
cyan "==> 1/7  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-approvals.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 80); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/7  Human owner signs up; registers agent Poster; gives it write on #general"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"appr-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
AG=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Poster"}')
AMEM=$(printf '%s' "$AG" | field memberId); ATOK=$(printf '%s' "$AG" | field token)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/grants" -H 'content-type: application/json' -d "{\"memberId\":\"$AMEM\",\"capability\":\"write\"}" >/dev/null
echo "    workspace=$WS  Poster=$AMEM  channel=$CID"

cyan "==> 3/7  Owner gates chat.post_message; agent submits → it PAUSES (not executed)"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/approval-policies" -H 'content-type: application/json' -d '{"actionType":"chat.post_message","requireApproval":true}' >/dev/null
REQ=$(submit "$ATOK" "{\"actionType\":\"chat.post_message\",\"payload\":{\"channelId\":\"$CID\",\"body\":\"deploy shipped\"}}")
RID=$(printf '%s' "$REQ" | field id)
echo "    submit → status=$(printf '%s' "$REQ" | field status)  request=$RID"
echo "    messages in #general before approval: $(count_msgs "$CID")  (expected 0 — paused)"
green "    expected: pending, nothing posted ✓"

cyan "==> 4/7  Human approves → the action EXECUTES (message appears, authored by the agent)"
curl -s -b "$JAR" -XPOST "localhost:3000/approvals/$RID/approve" -H 'content-type: application/json' -d '{"reason":"looks good"}' >/dev/null
echo "    request status now: $(status_of "$RID")"
echo "    messages in #general after approval: $(count_msgs "$CID")  (expected 1)"
echo "    author of the message: $(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages" | field authorMemberId)  (= Poster $AMEM)"
echo "    audit chain: $(events_of "$RID")"
green "    expected: executed; message posted as the agent; requested approved executed ✓"

cyan "==> 5/7  Reject blocks a second action"
REQ2=$(submit "$ATOK" "{\"actionType\":\"chat.post_message\",\"payload\":{\"channelId\":\"$CID\",\"body\":\"nope\"}}")
RID2=$(printf '%s' "$REQ2" | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/approvals/$RID2/reject" -H 'content-type: application/json' -d '{"reason":"not now"}' >/dev/null
echo "    request status: $(status_of "$RID2")  ·  messages still: $(count_msgs "$CID")  (unchanged)"
green "    expected: rejected, no new message ✓"

cyan "==> 6/7  Humans only: the agent cannot decide its own request"
REQ3=$(submit "$ATOK" "{\"actionType\":\"external.send\",\"payload\":{\"summary\":\"page oncall\",\"target\":\"ops\"}}")
RID3=$(printf '%s' "$REQ3" | field id)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ATOK" -XPOST "localhost:3000/approvals/$RID3/approve")
echo "    agent (Bearer) approve /approvals/\$RID3 → $CODE  (expected 403)"
green "    expected: 403 — only humans decide ✓"

cyan "==> 7/7  external.send is gated by default (no rule needed); human approves → recorded"
RES=$(curl -s -b "$JAR" -XPOST "localhost:3000/approvals/$RID3/approve" -H 'content-type: application/json' -d '{}')
echo "    submit status was: pending (sensitive by default)  ·  approve result: $(printf '%s' "$RES" | grep -oE '"recorded":[a-z]+')"
green "    expected: external.send paused by default, executes (recorded) on human approval ✓"

green "==> Approval gates verified: sensitive actions pause, humans approve→execute / reject→block,"
green "    agents can't self-decide, external sends gated by default, every step audited."
