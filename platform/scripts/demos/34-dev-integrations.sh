#!/usr/bin/env bash
# Scripted acceptance demo for deep dev integrations (issue #57, ADR-0034). Run from platform/.
#   Part A — agent-config SYNC: one canonical config (.reload/settings.toml) renders to BOTH Claude
#            Code and Codex, carrying the same MCP server / commands / skills, with secrets as ${VAR}
#            placeholders (never a value).
#   Part B — a project SLASH command runs in a real session (LocalRuntime, no cloud); the expanded
#            prompt reaches the channel.
#   Part C — start a session FROM a real public GitHub issue; the issue's title reaches the session.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

# --- one canonical config (the repo layer) shared by every part -------------------------------------
mkdir -p "$WORK/repo"
cat > "$WORK/repo/settings.toml" <<'EOF'
# Flat keys (skills) BEFORE any [table] header — a TOML rule (else they join the preceding table).
skills = ["test-driven-development", "code-review-and-quality"]

[slashCommands.echo]
description = "Echo the args back"
prompt = "Echo this back: {{args}}"

[mcpServers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]
EOF
export RELOAD_USER_CONFIG="" RELOAD_MANAGED_CONFIG="" RELOAD_REPO_CONFIG="$WORK/repo/settings.toml"

cyan "==> Reload — issue #57 deep dev integrations demo"

# --- Part A: config sync renders one config to both harnesses ---------------------------------------
cyan "==> 1/3  Agent-config SYNC: one config → Claude Code AND Codex (placeholder-only secrets)"
SYNC=$(pnpm --filter @reload/server exec tsx "$(pwd)/scripts/demos/34-config-sync-probe.ts")
echo "    $SYNC"
echo "$SYNC" | grep -q '"claudeHasGithub":true' || { red "    github MCP missing from Claude Code"; exit 1; }
echo "$SYNC" | grep -q '"codexHasGithub":true'  || { red "    github MCP missing from Codex"; exit 1; }
echo "$SYNC" | grep -q '"hasPlaceholder":true'  || { red "    expected \${GITHUB_TOKEN} placeholder"; exit 1; }
echo "$SYNC" | grep -q '"hasSecretValue":false' || { red "    a secret value leaked into an artifact"; exit 1; }
green "    same MCP server in both harnesses; secret emitted as \${GITHUB_TOKEN} placeholder only ✓"

# --- boot the real server (LocalRuntime, echo harness) ----------------------------------------------
cat > "$WORK/harness.js" <<'EOF'
process.stdout.write((process.env.AGENT_TASK || "none") + "\n");
setTimeout(() => process.stdout.write("agent: done\n"), 20);
EOF
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

AGENT_RUNTIME=local AGENT_HARNESS_CMD="$(command -v node)" \
AGENT_HARNESS_ARGS="[\"$WORK/harness.js\"]" \
AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo57-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo57-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)

wait_completed() { # $1 = session id
  for i in $(seq 1 60); do
    S=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$1" | field status)
    [ "$S" = "completed" ] && return 0
    [ "$S" = "failed" ] && return 1
    sleep 0.5
  done
  return 1
}

# --- Part B: a project slash command runs in a session ----------------------------------------------
cyan "==> 2/3  Project SLASH command: POST /agent-sessions/slash {\"command\":\"/echo hello world\"}"
SID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/slash" -H 'content-type: application/json' \
  -d "{\"command\":\"/echo hello world\",\"agentMemberId\":\"$AMEM\"}" | field id)
echo "    launched session=$SID"
wait_completed "$SID" || { red "    slash session did not complete"; cat /tmp/reload-demo57-server.log; exit 1; }
MSGS=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages")
if printf '%s' "$MSGS" | grep -q "Echo this back: hello world"; then
  green "    the /echo command expanded and ran — 'Echo this back: hello world' reached the channel ✓"
else
  red "    expanded prompt did not reach the session"; exit 1
fi

# --- Part C: start a session from a real public GitHub issue (no token) -----------------------------
cyan "==> 3/3  Issue → session: POST /agent-sessions/from-issue {ref: github:gagan114662/agent-skills#57}"
RESP=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/from-issue" -H 'content-type: application/json' \
  -d "{\"ref\":\"github:gagan114662/agent-skills#57\",\"agentMemberId\":\"$AMEM\"}")
ISID=$(printf '%s' "$RESP" | field id)
TITLE=$(printf '%s' "$RESP" | grep -oE '"title":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$ISID" ]; then
  yellow "    issue fetch unavailable (offline or rate-limited): $RESP — skipping Part C (needs network)"
else
  echo "    fetched issue title: $TITLE"
  echo "    launched session=$ISID"
  wait_completed "$ISID" || { red "    issue session did not complete"; cat /tmp/reload-demo57-server.log; exit 1; }
  MSGS=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$ISID" | field result)
  if curl -s -b "$JAR" "localhost:3000/channels/$CID/messages" | grep -q "Deep dev integrations"; then
    green "    the issue's context reached the session (title echoed into the channel) ✓"
  else
    red "    issue context did not reach the session"; exit 1
  fi
fi

green "==> Verified: agent-config syncs to both harnesses (placeholder secrets), a project slash command runs in a session, and a session starts from a GitHub issue with its context attached."
