#!/usr/bin/env bash
# Scripted acceptance demo for the Run tab (issue #56), proven against the real server (LocalRuntime,
# no cloud). It exercises the full loop end to end:
#   1. configure a project run command (repo-scope #58 config — TRUSTED, never request-supplied)
#   2. launch an agent session, then POST .../run → the dev server is spawned in the session's worktree
#   3. the bound localhost port is auto-detected → the run reaches `running` with a preview url
#   4. curl that url to prove the previewed app is actually reachable (the iframe's source)
#   5. POST .../annotations → a follow-up agent session is launched in the channel (the round trip)
#   6. POST .../run/stop → the run process is killed
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

# --- the project's run command: a tiny dev server that binds a port + logs a detectable banner ------
cat > "$WORK/devserver.js" <<'EOF'
const http = require("http");
const s = http.createServer((_, res) => res.end("hello from the previewed app"));
s.listen(0, "127.0.0.1", () => console.log("listening on http://localhost:" + s.address().port));
EOF
cat > "$WORK/repo-settings.toml" <<EOF
[run]
command = "$(command -v node) $WORK/devserver.js"
EOF

cyan "==> Reload — issue #56 Run tab demo (run → preview → annotate → agent)"

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

RELOAD_USER_CONFIG="" RELOAD_MANAGED_CONFIG="" \
RELOAD_REPO_CONFIG="$WORK/repo-settings.toml" \
AGENT_RUNTIME=local AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo56-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

# --- seed: human + channel + agent + a session whose app we will run --------------------------------
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo56-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)
SID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"build the app\"}" | field id)
echo "    launched session=$SID into #agents"

cyan "==> 1/4  Run the session's app → detect the bound localhost port"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/run" >/dev/null
URL=""; RUN=""
for i in $(seq 1 40); do
  RUN=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID/run")
  URL=$(printf '%s' "$RUN" | grep -oE '"url":"http[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "$URL" ]; then break; fi
  sleep 0.25
done
if [ -z "$URL" ]; then red "    port never detected — last run state: $RUN"; cat /tmp/reload-demo56-server.log; exit 1; fi
green "    run is 'running' → preview url detected: $URL ✓"

cyan "==> 2/4  The previewed app is actually reachable (this url is the iframe's source)"
BODY=$(curl -s "$URL")
echo "    GET $URL → $BODY"
printf '%s' "$BODY" | grep -q "previewed app" || { red "    preview url did not respond"; exit 1; }
green "    app responded over the detected port ✓"

cyan "==> 3/4  Annotate the preview → the notes reach the agent as a NEW follow-up session"
BEFORE=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions" | grep -o '"id":' | wc -l | tr -d ' ')
ANN=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/annotations" -H 'content-type: application/json' \
  -d '{"annotations":[{"x":0.34,"y":0.12,"note":"the Save button is misaligned","pageUrl":"'"$URL"'"}]}')
FOLLOW=$(printf '%s' "$ANN" | field sessionId)
[ -n "$FOLLOW" ] && [ "$FOLLOW" != "$SID" ] || { red "    no follow-up session launched"; exit 1; }
AFTER=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions" | grep -o '"id":' | wc -l | tr -d ' ')
echo "    follow-up session=$FOLLOW (sessions in channel: $BEFORE → $AFTER)"
[ "$AFTER" -gt "$BEFORE" ] || { red "    session count did not grow"; exit 1; }
green "    annotation delivered to the agent as a follow-up session ✓"

cyan "==> 4/4  Stop the run process"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/run/stop" >/dev/null
ST=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID/run" | field status)
[ "$ST" = "stopped" ] || { red "    run did not stop (status=$ST)"; exit 1; }
green "    run process stopped ✓"

green "==> #56 Run tab demo passed — run → preview → annotate → agent, end to end."
