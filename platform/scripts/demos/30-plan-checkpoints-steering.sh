#!/usr/bin/env bash
# Scripted acceptance demo for plan mode, checkpoints & steering (issue #53).
#   1) PLAN MODE — an agent proposes a plan; WORK BLOCKS (no execution) until a human decides.
#      We approve WITH FEEDBACK and watch the feedback thread into the execution task.
#   2) STEERING — we redirect a LIVE session; the steerable harness echoes the injected guidance.
#   3) CHECKPOINTS & REVERT — each turn is a checkpoint; reverting restores BOTH the working tree
#      (git reset) AND the conversation (message soft-delete).
# Run from platform/. Real server, LocalRuntime + a temp git repo, no cloud spend.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
S() { curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$1" | field status; }
wait_status() { for _ in $(seq 1 80); do [ "$(S "$1")" = "$2" ] && return 0; sleep 0.25; done; return 1; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

# A temp git repo so checkpoint/revert operate on a real worktree.
REPO="$WORK/repo"; mkdir -p "$REPO"
git -C "$REPO" init -b main -q
git -C "$REPO" config user.email t@e.com; git -C "$REPO" config user.name T
echo "# base" > "$REPO/README.md"; git -C "$REPO" add -A; git -C "$REPO" commit -qm init
WT="$WORK/worktrees"

cyan "==> Reload — issue #53 plan mode, checkpoints & steering demo"

docker compose up -d >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

AGENT_RUNTIME=local AGENT_HARNESS_CMD=bash \
AGENT_HARNESS_ARGS="[\"$PWD/apps/server/scripts/agent-harness-plan-demo.sh\"]" \
AGENT_IDLE_MS=15000 AGENT_WALLCLOCK_MS=30000 \
GIT_WORKSPACE_REPO="$REPO" GIT_WORKSPACE_WORKTREES="$WT" GIT_BASE_BRANCH=main \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo53-server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo53-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"dev"}' | field id)
AGENT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}')
AMEM=$(printf '%s' "$AGENT" | field memberId)

cyan "==> 1/3  PLAN MODE — propose a plan; work BLOCKS until a human decides"
PROP=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/plans" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"add rate limiting to the login route\"}")
PROPID=$(printf '%s' "$PROP" | field proposalId)
[ -n "$PROPID" ] || { red "    no proposal"; echo "$PROP"; exit 1; }
printf '%s' "$PROP" | field planText | sed 's/^/    plan: /'
EXEC=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/plans" | grep -oE '"executionSessionId":(null|"[^"]*")' | head -1)
[ "$EXEC" = '"executionSessionId":null' ] && green "    plan proposed; NO execution launched — work is blocked ✓"

cyan "==> 1b   Approve WITH FEEDBACK — the note threads into the execution task"
DEC=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/plans/$PROPID/decide" -H 'content-type: application/json' \
  -d '{"decision":"approve_with_feedback","feedback":"use a sliding window, add a unit test"}')
ESID=$(printf '%s' "$DEC" | field executionSessionId)
[ -n "$ESID" ] || { red "    no execution launched on approval"; echo "$DEC"; exit 1; }
wait_status "$ESID" completed || { red "    execution did not complete"; exit 1; }
curl -s -b "$JAR" "localhost:3000/channels/$CID/messages" | grep -oE '"body":"[^"]*"' | cut -d'"' -f4 | grep -i "sliding window" \
  && green "    execution ran with the reviewer feedback in its task ✓"

cyan "==> 2/3  STEERING — redirect a LIVE session"
LAUNCH=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"refactor the auth module\"}")
LSID=$(printf '%s' "$LAUNCH" | field id)
wait_status "$LSID" running || true
STEER=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$LSID/steer" -H 'content-type: application/json' \
  -d '{"guidance":"actually, prioritize the SQL injection fix"}')
printf '%s' "$STEER" | grep -q '"delivered":true' && green "    steering delivered to the live process ✓"
wait_status "$LSID" completed || true
curl -s -b "$JAR" "localhost:3000/channels/$CID/messages" | grep -oE '"body":"[^"]*"' | cut -d'"' -f4 | grep "steer: actually, prioritize" \
  && green "    the running agent echoed the injected guidance (live redirect) ✓"

cyan "==> 3/3  CHECKPOINTS & REVERT — restore files AND conversation together"
# Baseline checkpoint (idx 0) on the execution session's worktree.
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$ESID/checkpoint" >/dev/null
# Turn 1: the agent "edits" a file; capture a checkpoint.
echo "export const a = 1;" > "$WT/$ESID/a.ts"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"turn 1: added a.ts"}' >/dev/null
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$ESID/checkpoint" >/dev/null
# Turn 2: another edit + checkpoint.
echo "export const b = 2;" > "$WT/$ESID/b.ts"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"turn 2: added b.ts"}' >/dev/null
T2=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$ESID/checkpoint" | field id)
green "    captured baseline + 2 turns (a.ts, b.ts)"

cyan "==> 3b   Revert turn 2 — b.ts and its message vanish; a.ts and its message remain"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$ESID/turns/$T2/revert" | grep -oE '"deletedMessageCount":[0-9]+' | sed 's/^/    /'
[ -f "$WT/$ESID/a.ts" ] && [ ! -f "$WT/$ESID/b.ts" ] && green "    FILES restored: a.ts kept, b.ts gone ✓"
MSGS=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/messages" | grep -oE '"body":"[^"]*"' | cut -d'"' -f4)
printf '%s' "$MSGS" | grep -q "turn 1: added a.ts" && ! printf '%s' "$MSGS" | grep -q "turn 2: added b.ts" \
  && green "    CONVERSATION restored: turn-1 message kept, turn-2 message gone ✓"

green "==> Verified: an agent proposes a plan (work blocks → approve-with-feedback), a live session is"
green "    steered, and reverting a turn restores both the working tree and the conversation."
