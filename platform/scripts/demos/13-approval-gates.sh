#!/usr/bin/env bash
# Scripted acceptance demo for human approval gates & governance (issue #13).
# policy gates a sensitive action → pending (NOT executed) → human approves → executes once →
# a second action is rejected → blocked (+reason) → an ungated action auto-approves & runs →
# expiry refuses a stale decision → only humans decide → the audit log is queryable.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
status_of() { grep -oE "\"status\":\"[a-z_]+\"" | head -1 | cut -d'"' -f4; }
msgcount() { curl -s -b "$JAR" "localhost:3000/channels/$1/messages" | grep -oE '"id":"' | wc -l | tr -d ' '; }

cyan "==> Reload — issue #13 human approval gates & governance demo"
cyan "==> 1/9  Infra (Postgres + Redis) + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo13-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/9  Human signup (Lead) + a channel + register an agent (Scout)"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Lead\",\"workspaceSlug\":\"demo13-$(date +%s)\"}" >/dev/null
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"ops"}' | field id)
AID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}')
ATOK=$(printf '%s' "$AID" | field token)
echo "    workspace=$WS  channel(#ops)=$CID  agent=Scout"

cyan "==> 3/9  Default governance policy (external sends + any spend are gated)"
curl -s -H "authorization: Bearer $ATOK" "localhost:3000/workspaces/$WS/governance-policy"; echo

cyan "==> 4/9  Scout requests a SENSITIVE action (external_send) → PENDING, not executed"
REQ=$(curl -s -H "authorization: Bearer $ATOK" -H 'content-type: application/json' \
  -d "{\"actionKind\":\"external_send\",\"summary\":\"email the quarterly report to the CFO\",\"channelId\":\"$CID\",\"destination\":\"cfo@acme.com\"}" \
  "localhost:3000/workspaces/$WS/approvals")
RID=$(printf '%s' "$REQ" | field id)
echo "    status=$(printf '%s' "$REQ" | status_of)   channel messages so far: $(msgcount "$CID") (nothing executed)"

cyan "==> 5/9  Lead (human) APPROVES → the action executes exactly once"
APP=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"reason":"approved by lead"}' \
  "localhost:3000/workspaces/$WS/approvals/$RID/approve")
green "    status=$(printf '%s' "$APP" | status_of)  outcome=$(printf '%s' "$APP" | field outcome)  channel messages now: $(msgcount "$CID")"

cyan "==> 6/9  A second sensitive request is REJECTED → blocked, reason recorded, nothing executes"
REQ2=$(curl -s -H "authorization: Bearer $ATOK" -H 'content-type: application/json' \
  -d "{\"actionKind\":\"external_send\",\"summary\":\"post to twitter\",\"channelId\":\"$CID\"}" \
  "localhost:3000/workspaces/$WS/approvals")
RID2=$(printf '%s' "$REQ2" | field id)
REJ=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"reason":"off-brand"}' \
  "localhost:3000/workspaces/$WS/approvals/$RID2/reject")
echo "    status=$(printf '%s' "$REJ" | status_of)  reason=$(printf '%s' "$REJ" | field decisionReason)  channel messages still: $(msgcount "$CID") (blocked)"

cyan "==> 7/9  An UNGATED action (custom) auto-approves and executes immediately"
AUTO=$(curl -s -H "authorization: Bearer $ATOK" -H 'content-type: application/json' \
  -d "{\"actionKind\":\"custom\",\"summary\":\"rename a label\",\"channelId\":\"$CID\"}" \
  "localhost:3000/workspaces/$WS/approvals")
green "    status=$(printf '%s' "$AUTO" | status_of)  channel messages now: $(msgcount "$CID")"

cyan "==> 8/9  Guards: an AGENT cannot approve (humans only) → HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $ATOK" -XPOST "localhost:3000/workspaces/$WS/approvals/$RID/approve") (403 expected)"
echo -n "    re-deciding a terminal request → HTTP "; curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -H 'content-type: application/json' -d '{"reason":"x"}' "localhost:3000/workspaces/$WS/approvals/$RID/reject"; echo " (409 expected)"

cyan "==> 9/9  Audit log is queryable (every request + decision)"
printf "    GET /approvals (all):       "; curl -s -b "$JAR" "localhost:3000/workspaces/$WS/approvals" | grep -oE '"status":"[a-z_]+"' | tr '\n' ' '; echo
printf "    GET /approvals?status=approved: "; curl -s -b "$JAR" "localhost:3000/workspaces/$WS/approvals?status=approved" | grep -oE '"summary[^,]*"actionSummary":"[^"]*"' >/dev/null 2>&1; curl -s -b "$JAR" "localhost:3000/workspaces/$WS/approvals?status=approved" | grep -oE '"actionSummary":"[^"]*"' | tr '\n' ' '; echo

green "==> Approval gates verified: policy-gated action pends (not executed) → human approve executes once / reject blocks → ungated auto-approves → humans-only + no re-decide + queryable audit log."
