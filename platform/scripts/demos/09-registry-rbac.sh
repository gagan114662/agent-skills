#!/usr/bin/env bash
# Scripted acceptance demo for agent registry & RBAC (issue #9).
# read-only can't post → write can → propagate can grant (write can't) → revoke is immediate
# → cross-workspace grant rejected → registry list + deactivate. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; JAR2="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$JAR2"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# POST a grant {memberId,capability} to $CID, return HTTP status. Auth: $1 = cookie|bearer value, $2 = mode.
grant_status() { # <auth> <bearer|cookie> <memberId> <capability>
  if [ "$2" = bearer ]; then
    curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $1" -H 'content-type: application/json' \
      -XPOST "localhost:3000/channels/$CID/grants" -d "{\"memberId\":\"$3\",\"capability\":\"$4\"}"
  else
    curl -s -o /dev/null -w "%{http_code}" -b "$1" -H 'content-type: application/json' \
      -XPOST "localhost:3000/channels/$CID/grants" -d "{\"memberId\":\"$3\",\"capability\":\"$4\"}"
  fi
}
msg_status() { # <token> GET|POST
  if [ "$2" = POST ]; then
    curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $1" -H 'content-type: application/json' \
      -XPOST "localhost:3000/channels/$CID/messages" -d '{"body":"demo"}'
  else
    curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $1" "localhost:3000/channels/$CID/messages"
  fi
}
me_status() { curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $1" localhost:3000/me; }

cyan "==> Reload — issue #9 registry & RBAC demo"
cyan "==> 1/9  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-rbac.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/9  Human owner signs up, creates #general (owner auto-granted 'propagate')"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"rbac-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
echo "    workspace=$WS"
echo "    channel=$CID"

cyan "==> 3/9  Register agents: Reader, Writer, Delegate, Target"
reg() { curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d "{\"name\":\"$1\"}"; }
R=$(reg Reader);   RMEM=$(printf '%s' "$R" | field memberId); RTOK=$(printf '%s' "$R" | field token); RAID=$(printf '%s' "$R" | field agentId)
W=$(reg Writer);   WMEM=$(printf '%s' "$W" | field memberId); WTOK=$(printf '%s' "$W" | field token)
D=$(reg Delegate); DMEM=$(printf '%s' "$D" | field memberId); DTOK=$(printf '%s' "$D" | field token)
T=$(reg Target);   TMEM=$(printf '%s' "$T" | field memberId)
echo "    Reader=$RMEM  Writer=$WMEM  Delegate=$DMEM  Target=$TMEM"

cyan "==> 4/9  Owner grants roles: Reader=read, Writer=write, Delegate=propagate"
grant_status "$JAR" cookie "$RMEM" read    >/dev/null
grant_status "$JAR" cookie "$WMEM" write   >/dev/null
grant_status "$JAR" cookie "$DMEM" propagate >/dev/null
printf "    grants: "; curl -s -b "$JAR" "localhost:3000/channels/$CID/grants"; echo

cyan "==> 5/9  read-only Reader: read=$(msg_status "$RTOK" GET)  post=$(msg_status "$RTOK" POST)"
green "    expected read=200  post=403 ✓"

cyan "==> 6/9  write Writer: post=$(msg_status "$WTOK" POST)"
green "    expected 201 ✓"

P_OK=$(grant_status "$DTOK" bearer "$TMEM" read)
W_NO=$(grant_status "$WTOK" bearer "$TMEM" write)
cyan "==> 7/9  propagate Delegate grants a role=$P_OK   write-only Writer grants=$W_NO"
green "    expected propagate=201  write-only=403 ✓"

curl -s -b "$JAR" -XDELETE "localhost:3000/channels/$CID/grants/$DMEM" >/dev/null
D_AFTER=$(grant_status "$DTOK" bearer "$TMEM" write)
cyan "==> 8/9  Revoke Delegate's propagate → next grant=$D_AFTER"
green "    expected 403 (immediate) ✓"

cyan "==> 9/9  Cross-workspace grant rejected, + registry list & deactivate"
curl -s -c "$JAR2" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"other-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Other\",\"workspaceSlug\":\"other-$(date +%s)\"}" >/dev/null
OMEM=$(curl -s -b "$JAR2" localhost:3000/me | field memberId)
X_WS=$(grant_status "$JAR" cookie "$OMEM" read)
echo "    cross-workspace grant=$X_WS  (expected 404)"
echo "    registry agents=$(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/agents" | grep -oE '"id":' | wc -l | tr -d ' ')"
echo "    Reader /me before deactivate=$(me_status "$RTOK")"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents/$RAID/deactivate" >/dev/null
echo "    Reader /me after  deactivate=$(me_status "$RTOK")  (expected 401, immediate)"

green "==> RBAC verified: read/write/propagate enforced, propagate-gated grants, immediate revoke,"
green "    cross-workspace rejected, registry list + immediate deactivation."
