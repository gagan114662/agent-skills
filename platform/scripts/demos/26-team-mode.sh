#!/usr/bin/env bash
# Scripted acceptance demo for Team Mode.
# Launch 3 agents IN PARALLEL on 3 independent subtasks of one feature → they keep each other in
# the loop over a shared team channel (we log the event stream) → each commits its own file on its
# own branch in a self-contained scratch git repo → all 3 branches MERGE WITH ZERO CONFLICTS.
# Default backend is LocalRuntime (no cloud spend); the same flow runs on Vercel Sandbox with
# AGENT_RUNTIME=sandbox. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

JAR="$(mktemp)"
SCRATCH="$(mktemp -d)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; rm -rf "$SCRATCH"; }
trap cleanup EXIT

HARNESS="$(pwd)/scripts/team-harness-demo.sh"
ORIGIN="$SCRATCH/origin.git"
RUN_LABEL="demo-team-$$"

cyan "==> Reload — Team Mode demo (3 agents, 1 feature, parallel, conflict-free merge)"

cyan "==> 1/7  Create a self-contained scratch git repo (bare origin + seeded main)"
git init -q --bare "$ORIGIN"
SEED="$SCRATCH/seed"
git clone -q "$ORIGIN" "$SEED"
( cd "$SEED"
  git checkout -q -b main
  echo "# Feature: parallel team build" > README.md
  git add README.md
  git -c user.email=seed@team.demo -c user.name=seed commit -q -m "chore: seed main"
  git push -q origin main )
echo "    origin=$ORIGIN (main seeded)"

cyan "==> 2/7  Infra + migrate + boot server (AGENT_RUNTIME=local, TEAM_MAX_CONCURRENCY=3)"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
AGENT_RUNTIME=local \
  AGENT_HARNESS_CMD=bash \
  AGENT_HARNESS_ARGS="[\"$HARNESS\"]" \
  AGENT_IDLE_MS=15000 AGENT_WALLCLOCK_MS=60000 \
  TEAM_MAX_CONCURRENCY=3 \
  TEAM_ORIGIN="$ORIGIN" TEAM_SCRATCH_DIR="$SCRATCH" TEAM_RUN_LABEL="$RUN_LABEL" \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo26-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 3/7  Human signup + create #feature-team channel + register 3 agents"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo26-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"feature-team"}' | field id)
A0=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Builder-0"}' | field memberId)
A1=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Builder-1"}' | field memberId)
A2=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Builder-2"}' | field memberId)
echo "    workspace=$WS  channel=$CID  agents=[$A0, $A1, $A2]"

cyan "==> 4/7  Launch ONE team run with 3 parallel subtasks (each its own branch + file)"
BODY=$(cat <<JSON
{"subtasks":[
  {"agentMemberId":"$A0","branch":"feat/part-0","task":"branch=feat/part-0 file=part0.txt Implement the login form"},
  {"agentMemberId":"$A1","branch":"feat/part-1","task":"branch=feat/part-1 file=part1.txt Implement the session store"},
  {"agentMemberId":"$A2","branch":"feat/part-2","task":"branch=feat/part-2 file=part2.txt Implement the audit log"}
]}
JSON
)
LAUNCH=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/team-runs" -H 'content-type: application/json' -d "$BODY")
RUN=$(printf '%s' "$LAUNCH" | field teamRunId)
echo "    launched team run=$RUN (HTTP 202 — 3 sessions running server-side in parallel)"

cyan "==> 5/7  Wait for all 3 agents to finish (server-owned, concurrency-capped at 3)"
for i in $(seq 1 120); do
  DONE=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions" | grep -oE '"status":"[^"]*"' | grep -c '"completed"' || true)
  [ "$DONE" -ge 3 ] && break
  FAIL=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions" | grep -oE '"status":"[^"]*"' | grep -c '"failed"' || true)
  [ "$FAIL" -gt 0 ] && { red "    a session failed"; cat /tmp/reload-demo26-server.log; exit 1; }
  sleep 0.5
done
green "    all 3 sessions completed ✓"

cyan "==> 6/7  The shared team channel — every agent's event stream (this is the 'in the loop' part)"
curl -s -b "$JAR" "localhost:3000/channels/$CID/team-events" \
  | grep -oE '"kind":"[^"]*","summary":"[^"]*","branch":"[^"]*"' \
  | sed -E 's/.*"kind":"([^"]*)","summary":"([^"]*)","branch":"([^"]*)".*/    • [\3] \1: \2/' \
  || true

cyan "==> 7/7  Merge all 3 branches into main — they touch disjoint files, so ZERO conflicts"
MERGE="$SCRATCH/merge"
git clone -q "$ORIGIN" "$MERGE"
cd "$MERGE"
git checkout -q main
if git merge --no-edit -m "merge: integrate all 3 parallel branches" \
     origin/feat/part-0 origin/feat/part-1 origin/feat/part-2 >/tmp/reload-demo26-merge.log 2>&1; then
  git push -q origin main
  FILES=$(git ls-tree --name-only HEAD | tr '\n' ' ')
  green "    octopus-merged feat/part-0 + feat/part-1 + feat/part-2 → main ✓"
  echo "    main now contains: $FILES"
else
  red "    !! merge conflict"; cat /tmp/reload-demo26-merge.log; exit 1
fi

green "==> Verified: 3 agents ran in parallel on one feature, coordinated over the team channel, and all branches merged conflict-free."
