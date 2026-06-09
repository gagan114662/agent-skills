#!/usr/bin/env bash
# Scripted acceptance demo for custom subagents / agent personas (issue #59).
#   1) Define an @-mentionable `code-reviewer` persona (system prompt + allowed-tools ceiling).
#   2) Invoke it by @mention on a diff message — it runs the REAL harness scoped to its tools and
#      threads its review back UNDER the invoking message (the result returns into the parent thread).
#      The demo harness echoes the persona env it received, so you can SEE the scoped tools + prompt.
#   3) Prove non-escalation: a caller without `propagate` is denied (403); the persona's tool ceiling
#      cannot be widened (a request for Bash/Write is narrowed to the allowed set).
# Run from platform/. Real server, LocalRuntime, no cloud spend.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

# A cwd-independent harness that echoes the persona env it was given (proves scoping reached it).
cat > "$WORK/reviewer.js" <<'EOF'
console.log("reviewer: task=" + (process.env.AGENT_TASK || "none"));
console.log("reviewer: tools=" + (process.env.AGENT_ALLOWED_TOOLS || "none"));
console.log("reviewer: prompt=" + (process.env.AGENT_APPEND_SYSTEM_PROMPT || "none"));
console.log("reviewer: review — looks good; nit: add a test for the error path");
EOF

cyan "==> Reload — issue #59 custom subagents / agent personas demo"

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

AGENT_RUNTIME=local AGENT_HARNESS_CMD="$(command -v node)" \
AGENT_HARNESS_ARGS="[\"$WORK/reviewer.js\"]" \
AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo59-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo59-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)

cyan "==> 1/4  Define an @code-reviewer persona (prompt + tool ceiling [Read, Grep])"
PERSONA=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/personas" -H 'content-type: application/json' \
  -d '{"name":"code-reviewer","systemPrompt":"Review the diff. Cite file:line.","allowedTools":["Read","Grep"]}')
PID=$(printf '%s' "$PERSONA" | field id)
PMEM=$(printf '%s' "$PERSONA" | field agentMemberId)
[ -n "$PID" ] || { red "    persona not created"; echo "$PERSONA"; exit 1; }
green "    persona @code-reviewer defined (id=$PID) — it is now @-mentionable ✓"

CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"dev"}' | field id)
# Grant the persona write on #dev — its OWN RBAC scope there (the session runs AS this member).
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/grants" -H 'content-type: application/json' \
  -d "{\"memberId\":\"$PMEM\",\"capability\":\"write\"}" >/dev/null

cyan "==> 2/4  @mention it on a diff — it runs scoped to its tools and replies in-thread"
MID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' \
  -d '{"body":"@code-reviewer please review this diff: src/auth.ts changed token TTL"}' | field id)
SID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages/$MID/subagents" -H 'content-type: application/json' \
  -d '{}' | field sessionId)
[ -n "$SID" ] || { red "    subagent not launched"; exit 1; }
echo "    launched subagent session=$SID, threaded under message=$MID"

for i in $(seq 1 60); do
  S=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID" | field status)
  [ "$S" = "completed" ] && break
  [ "$S" = "failed" ] && { red "    session failed"; cat /tmp/reload-demo59-server.log; exit 1; }
  sleep 0.5
done

THREAD=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages/$MID/thread")
printf '%s' "$THREAD" | grep -oE '"body":"[^"]*"' | cut -d'"' -f4 | sed 's/^/    • /'
printf '%s' "$THREAD" | grep -q "reviewer: tools=Read,Grep" \
  || { red "    persona did not run scoped to [Read,Grep]"; exit 1; }
green "    @code-reviewer ran scoped to its tools (tools=Read,Grep) and replied under the message ✓"

cyan "==> 3/4  Non-escalation: a caller without 'propagate' cannot summon a subagent"
AG=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"caller"}')
ATOK=$(printf '%s' "$AG" | field token); AMEM=$(printf '%s' "$AG" | field memberId)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/grants" -H 'content-type: application/json' \
  -d "{\"memberId\":\"$AMEM\",\"capability\":\"write\"}" >/dev/null   # write, NOT propagate
CODE=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "localhost:3000/channels/$CID/personas/$PID/invoke" \
  -H "authorization: Bearer $ATOK" -H 'content-type: application/json' -d '{"task":"review"}')
[ "$CODE" = "403" ] || { red "    expected 403 for a non-propagate caller, got $CODE"; exit 1; }
green "    a write-only caller is denied (403) — invoking a subagent requires propagate ✓"

cyan "==> 4/4  Non-escalation: the tool ceiling cannot be widened (Bash/Write are dropped)"
MID2=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' \
  -d '{"body":"@code-reviewer re-check"}' | field id)
SID2=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/personas/$PID/invoke" -H 'content-type: application/json' \
  -d "{\"task\":\"re-check\",\"messageId\":\"$MID2\",\"tools\":[\"Read\",\"Bash\",\"Write\"]}" | field sessionId)
for i in $(seq 1 60); do
  S=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID2" | field status)
  [ "$S" = "completed" ] && break; [ "$S" = "failed" ] && { red "    session failed"; exit 1; }; sleep 0.5
done
T2=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages/$MID2/thread")
printf '%s' "$T2" | grep -q "reviewer: tools=Read" && ! printf '%s' "$T2" | grep -q "Bash" \
  || { red "    tool ceiling was not enforced"; exit 1; }
green "    requested [Read,Bash,Write] was narrowed to [Read] — a subagent cannot widen its tools ✓"

green "==> Verified: define + @mention-invoke a custom subagent that runs scoped to its tools and"
green "    replies in-thread, and the RBAC scope cannot be escalated (propagate gate + tool ceiling)."
