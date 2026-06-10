#!/usr/bin/env bash
# Scripted acceptance demo for Deploy-to-live-URL (issue #73), proven against the real server with the
# default no-spend dry-run provider (no cloud account, no spend). It exercises the full #73 surface:
#   1. configure repo-scope deploy settings (TRUSTED #58 config — never request-supplied) + a tenant secret
#   2. launch an agent session, then POST .../deploy → the app is deployed to a live HTTPS URL
#   3. the live URL is posted into the channel as a message (the "it's live" announcement)
#   4. the tenant secret NEVER appears in the deploy logs (redacted) — proven by grepping the log tail
#   5. POST .../deploy again (redeploy-on-push) → a NEW immutable deployment in the history (the backup set)
#   6. POST .../deploy/rollback → re-promote the prior good deployment
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

SECRET="sk-demo-deploy-secret-$$"

# --- the project's deploy settings: trusted repo-scope config (provider + framework), no secrets here ---
cat > "$WORK/repo-settings.toml" <<EOF
[deploy]
provider = "dryrun"
framework = "vite"
maxInstances = 3
EOF

cyan "==> Reload — issue #73 Deploy to a live URL demo (deploy → live URL → redeploy → rollback)"

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

# DEPLOY_PROVIDER defaults to dryrun (no spend). The secret is on the #25 secrets path, NEVER in config.
RELOAD_USER_CONFIG="" RELOAD_MANAGED_CONFIG="" \
RELOAD_REPO_CONFIG="$WORK/repo-settings.toml" \
AGENT_RUNTIME=local AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
AGENT_SECRETS="{\"*\":{\"DEPLOY_SECRET\":\"$SECRET\"}}" \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo73-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

# --- seed: human + channel + agent + a session whose app we will deploy ------------------------------
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo73-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)
SID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"build the app\"}" | field id)
echo "    launched session=$SID into #agents"

cyan "==> 1/5  Deploy the session's app → a live HTTPS URL"
DEP=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/deploy")
STATUS=$(printf '%s' "$DEP" | field status)
URL=$(printf '%s' "$DEP" | grep -oE '"url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || true)
[ "$STATUS" = "ready" ] && [ -n "$URL" ] || { red "    deploy did not reach ready with a url: $DEP"; cat /tmp/reload-demo73-server.log; exit 1; }
green "    deployment is 'ready' → live URL: $URL ✓"

cyan "==> 2/5  The live URL was posted into the channel (the 'it's live' announcement)"
MSGS=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages")
printf '%s' "$MSGS" | grep -q "$URL" || { red "    live URL was not posted to the channel"; exit 1; }
green "    channel message announces: ✅ Deployed to $URL ✓"

cyan "==> 3/5  The tenant secret NEVER appears in the deploy logs (redacted)"
LOGS=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID/deploy")
if printf '%s' "$LOGS" | grep -q "$SECRET"; then red "    SECRET LEAKED into deploy logs!"; exit 1; fi
printf '%s' "$LOGS" | grep -q "redacted" || { red "    expected a redaction mask in the logs"; exit 1; }
green "    secret scrubbed from the log tail (mask present, value absent) ✓"

cyan "==> 4/5  Redeploy on push → a NEW immutable deployment (the backup set grows)"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/deploy" -H 'content-type: application/json' \
  -d '{"reason":"push"}' >/dev/null
COUNT=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID/deploy/history" | grep -o '"id":' | wc -l | tr -d ' ')
echo "    deployments in history: $COUNT"
[ "$COUNT" -ge 2 ] || { red "    redeploy did not create a new immutable deployment"; exit 1; }
green "    redeploy created deployment #$COUNT — prior deployments retained as backups ✓"

cyan "==> 5/5  Rollback → re-promote the prior good deployment"
ROLL=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/deploy/rollback")
RSTATUS=$(printf '%s' "$ROLL" | field status)
FROM=$(printf '%s' "$ROLL" | field rolledBackFromId)
[ "$RSTATUS" = "rolled_back" ] && [ -n "$FROM" ] || { red "    rollback did not re-promote a prior deployment: $ROLL"; exit 1; }
green "    rolled back to a prior good deployment (rolledBackFromId=$FROM) ✓"

green "==> #73 Deploy demo passed — deploy → live URL → channel post → redeploy → rollback, secrets never logged."
