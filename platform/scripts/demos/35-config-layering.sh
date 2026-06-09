#!/usr/bin/env bash
# Scripted acceptance demo for file-backed config layering (issue #58).
#   Part A — layered TOML resolves env < user < repo < managed; a MANAGED setting overrides a repo
#            setting (the lock); a per-tenant [workspace.<id>] managed value wins for that tenant only;
#            data-privacy mode flips `egressAllowed` off.
#   Part B — a repo-scope `filesToCopy` lands in a NEW session's working dir, and the agent harness
#            (spawned in that cwd) reads it — proven against the real server (LocalRuntime, no cloud).
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

# --- write the three layers (user/repo/managed) into a temp dir -------------------------------------
mkdir -p "$WORK/repo" "$WORK/wsroot"
cat > "$WORK/user.toml"    <<'EOF'
workspaceRoot = "from-user"
EOF
cat > "$WORK/repo.toml"    <<'EOF'
workspaceRoot = "from-repo"
dataPrivacyMode = false
EOF
cat > "$WORK/managed.toml" <<'EOF'
[settings]
workspaceRoot = "from-managed"
dataPrivacyMode = true

[workspace.ws_acme]
dataPrivacyMode = false
EOF

export RELOAD_USER_CONFIG="$WORK/user.toml"
export RELOAD_REPO_CONFIG="$WORK/repo.toml"
export RELOAD_MANAGED_CONFIG="$WORK/managed.toml"
export RELOAD_WORKSPACE_ROOT="from-env"   # the lowest layer

cyan "==> Reload — issue #58 file-backed config layering demo"
cyan "==> 1/4  Resolve precedence env < user < repo < managed (no tenant)"
RES=$(pnpm --filter @reload/server exec tsx "$(pwd)/scripts/demos/35-config-probe.ts")
echo "    $RES"
echo "$RES" | grep -q '"workspaceRoot":"from-managed"' || { red "    expected managed to win"; exit 1; }
green "    workspaceRoot resolved to 'from-managed' — managed wins over repo/user/env ✓"

cyan "==> 2/4  Managed lock: data-privacy is ON globally and a lower layer cannot turn it off"
echo "$RES" | grep -q '"dataPrivacyMode":true' || { red "    expected managed dataPrivacyMode=true"; exit 1; }
echo "$RES" | grep -q '"egressAllowed":false' || { red "    expected egress disabled"; exit 1; }
green "    dataPrivacyMode=true (locked by managed) → egressAllowed=false ✓"

cyan "==> 3/4  Per-tenant managed override: ws_acme relaxes data-privacy; other tenants do NOT"
ACME=$(pnpm --filter @reload/server exec tsx "$(pwd)/scripts/demos/35-config-probe.ts" ws_acme)
OTHER=$(pnpm --filter @reload/server exec tsx "$(pwd)/scripts/demos/35-config-probe.ts" ws_other)
echo "    ws_acme : $ACME"
echo "    ws_other: $OTHER"
echo "$ACME"  | grep -q '"dataPrivacyMode":false' || { red "    expected ws_acme privacy off"; exit 1; }
echo "$OTHER" | grep -q '"dataPrivacyMode":true'  || { red "    expected ws_other privacy on"; exit 1; }
green "    per-tenant managed value wins for ws_acme only ✓"

# --- Part B: files-to-copy lands in a real session workspace ----------------------------------------
cyan "==> 4/4  files-to-copy: a repo-scope file lands in a new session's working dir, agent reads it"
MARKER="AGENT-CONTEXT-$$"
echo "$MARKER" > "$WORK/repo/agent-context.md"
cat > "$WORK/repo/.reload-settings.toml" <<EOF
filesToCopy = ["$WORK/repo/agent-context.md"]
workspaceRoot = "$WORK/wsroot"
EOF

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

# Boot the server with the repo config pointing at our temp settings; harness echoes its cwd file.
cat > "$WORK/harness.js" <<'EOF'
const fs = require("fs");
try {
  console.log("agent: ctx=" + fs.readFileSync("agent-context.md", "utf8").trim());
} catch {
  console.log("agent: ctx=MISSING");
}
EOF
RELOAD_USER_CONFIG="" RELOAD_MANAGED_CONFIG="" RELOAD_WORKSPACE_ROOT="" \
RELOAD_REPO_CONFIG="$WORK/repo/.reload-settings.toml" \
AGENT_RUNTIME=local AGENT_HARNESS_CMD="$(command -v node)" \
AGENT_HARNESS_ARGS="[\"$WORK/harness.js\"]" \
AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo58-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo58-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)
SID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"read your context\"}" | field id)
echo "    launched session=$SID into #agents"

for i in $(seq 1 60); do
  S=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID" | field status)
  [ "$S" = "completed" ] && break
  [ "$S" = "failed" ] && { red "    session failed"; cat /tmp/reload-demo58-server.log; exit 1; }
  sleep 0.5
done

# 1) the file physically landed in the per-session working dir
if [ -f "$WORK/wsroot/$SID/agent-context.md" ]; then
  green "    file copied → $WORK/wsroot/$SID/agent-context.md ✓"
else
  red "    file did NOT land in the session workspace"; exit 1
fi
# 2) the harness, spawned in that cwd, actually read it
MSGS=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages")
printf '%s' "$MSGS" | grep -oE '"body":"[^"]*"' | cut -d'"' -f4 | sed 's/^/    • /'
if printf '%s' "$MSGS" | grep -q "agent: ctx=$MARKER"; then
  green "    the agent read its copied context (marker $MARKER) from its working dir ✓"
else
  red "    the agent did not read the copied file"; exit 1
fi

green "==> Verified: layered config (env<user<repo<managed), managed lock + per-tenant override, data-privacy gate, and files-to-copy into a new session workspace."
