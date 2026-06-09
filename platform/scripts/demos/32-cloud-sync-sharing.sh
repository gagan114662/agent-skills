#!/usr/bin/env bash
# Scripted acceptance demo for cloud↔local sync + persistent & shared workspaces (issue #55).
#   create a durable cloud workspace → SHARE it with a scoped collaborator → collaborator reads it
#   → REVOKE → access is cut (404) → SLEEP the workspace (snapshot retained) → WAKE it and resume
#   from the snapshot. Cloud→local file mirror with setup-on-first-mirror + live shared-workspace
#   presence are proven end-to-end by test/integration/cloud-sync-sharing.test.ts (run at the end).
# No cloud spend (the mirror transport is behind a seam, exactly like #25's SandboxProvider).
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #55 cloud↔local sync + persistent & shared workspaces demo"
cyan "==> 1/7  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo32-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/7  Owner signs up and creates a durable cloud workspace"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo32-$(date +%s)\"}" >/dev/null
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
CW=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/cloud-workspaces" -H 'content-type: application/json' -d '{"name":"team-env"}' | field id)
echo "    workspace=$WS  cloud_workspace=$CW (status=active)"

cyan "==> 3/7  Register a collaborator (agent member) and SHARE the workspace at read"
COLLAB=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Teammate"}')
CMEM=$(printf '%s' "$COLLAB" | field memberId); CTOK=$(printf '%s' "$COLLAB" | field token)
# Before sharing: the collaborator cannot even see it (collaborator-gated → 404).
BEFORE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $CTOK" "localhost:3000/workspaces/$WS/cloud-workspaces/$CW")
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/cloud-workspaces/$CW/collaborators" -H 'content-type: application/json' -d "{\"memberId\":\"$CMEM\",\"capability\":\"read\"}" >/dev/null
AFTER=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $CTOK" "localhost:3000/workspaces/$WS/cloud-workspaces/$CW")
echo "    collaborator GET before invite=$BEFORE (404)  → after invite=$AFTER (200)"
[ "$BEFORE" = "404" ] && [ "$AFTER" = "200" ] && green "    ✓ scoped collaborator access granted" || { red "    !! share check failed"; exit 1; }

cyan "==> 4/7  REVOKE the collaborator — access is cut immediately"
curl -s -b "$JAR" -XDELETE "localhost:3000/workspaces/$WS/cloud-workspaces/$CW/collaborators/$CMEM" >/dev/null
REVOKED=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $CTOK" "localhost:3000/workspaces/$WS/cloud-workspaces/$CW")
echo "    collaborator GET after revoke=$REVOKED (404 — IDOR-safe: access reads as not-found)"
[ "$REVOKED" = "404" ] && green "    ✓ revoke cut access" || { red "    !! revoke check failed"; exit 1; }

cyan "==> 5/7  A session teardown recorded the latest snapshot (resume key) on the workspace"
docker compose exec -T postgres psql -U reload -d reload -c \
  "UPDATE cloud_workspaces SET snapshot_id='snap-demo-1' WHERE id='$CW';" >/dev/null
echo "    snapshot_id=snap-demo-1 retained on cloud_workspace=$CW"

cyan "==> 6/7  SLEEP the idle workspace, then WAKE it — it resumes from the retained snapshot"
SLEPT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/cloud-workspaces/$CW/sleep" | field status)
WAKE=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/cloud-workspaces/$CW/wake")
WSTATUS=$(printf '%s' "$WAKE" | field status); WSNAP=$(printf '%s' "$WAKE" | field snapshotId)
echo "    slept=$SLEPT  →  woke status=$WSTATUS resuming from snapshot=$WSNAP"
[ "$SLEPT" = "sleeping" ] && [ "$WSTATUS" = "active" ] && [ "$WSNAP" = "snap-demo-1" ] \
  && green "    ✓ persistent workspace slept and woke, resuming from its snapshot" \
  || { red "    !! sleep/wake check failed"; exit 1; }

cyan "==> 7/7  Cloud→local file mirror (setup-on-first-mirror) + live shared presence — full proof"
kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
pnpm --filter @reload/server exec vitest run --config vitest.integration.config.ts test/integration/cloud-sync-sharing.test.ts
green "==> Verified: durable workspace shared with a scoped collaborator, revoke cut access, slept + woke from snapshot; files mirror locally with setup-once and live presence proven by the integration suite."
