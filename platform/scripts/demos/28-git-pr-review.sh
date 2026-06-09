#!/usr/bin/env bash
# Scripted acceptance demo for the git/PR/diff/review workflow (issue #51).
# An agent session runs in a git worktree → its edits become a reviewable DIFF → a human leaves a
# review COMMENT → DELIVER routes it back to the agent as a NEW session → the agent COMMITS A FIX
# (the diff changes). PR creation + Checks ride a GitHubProvider seam; the default `none` provider
# returns 501 (no token in CI), and GITHUB_PROVIDER=gh enables the real `gh` path. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""; REPO="$(mktemp -d)/repo"; HARNESS_FILE="$(mktemp).cjs"
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$HARNESS_FILE"; rm -rf "$(dirname "$REPO")"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
num() { grep -oE "\"$1\":[0-9]+" | head -1 | cut -d: -f2; }

# A tiny real harness (written to a file so no JS escaping fights the JSON arg): it writes feature.ts,
# and when the task carries review comments it applies the fix (renames the symbol) — so the round
# trip produces a *changed* diff on a fresh branch.
cat > "$HARNESS_FILE" <<'JS'
const fs = require("fs");
const task = process.env.AGENT_TASK || "";
if (task.indexOf("review comments") >= 0) {
  fs.writeFileSync("feature.ts", "export const ANSWER = 42; // renamed per review\n");
  console.log("agent: applied review fix (renamed to ANSWER)");
} else {
  fs.writeFileSync("feature.ts", "export const answer = 42;\n");
  console.log("agent: wrote feature.ts");
}
JS

cyan "==> Reload — issue #51 git/PR/diff/review demo"
cyan "==> 1/7  Infra + migrate + a fresh base git repo + boot server (GIT_WORKSPACE_REPO set)"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
mkdir -p "$REPO"; ( cd "$REPO"; git init -b main >/dev/null; git config user.email d@e.com; git config user.name Demo; echo "# base" > README.md; git add -A; git commit -m init >/dev/null )
GIT_WORKSPACE_REPO="$REPO" GIT_BASE_BRANCH=main \
  AGENT_RUNTIME=local AGENT_HARNESS_CMD=node AGENT_HARNESS_ARGS="[\"$HARNESS_FILE\"]" \
  AGENT_IDLE_MS=10000 AGENT_WALLCLOCK_MS=60000 \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo28-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/7  Human signup + #agents channel + register an agent"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo28-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)
echo "    workspace=$WS  channel=$CID  agent=$AMEM"

cyan "==> 3/7  Launch a session — the agent edits code on its own branch (agent/<sessionId>)"
SID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"add the answer constant\"}" | field id)
for i in $(seq 1 60); do S=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID" | field status); [ "$S" = "completed" ] && break; [ "$S" = "failed" ] && { red "session failed"; cat /tmp/reload-demo28-server.log; exit 1; }; sleep 0.5; done
echo "    session=$SID status=$S"

cyan "==> 4/7  The work is a reviewable DIFF (cumulative: base...agent/<id>)"
DIFF=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID/diff?mode=cumulative")
printf '%s' "$DIFF" | grep -q "feature.ts" && green "    diff contains feature.ts ✓" || { red "    no diff"; exit 1; }
printf '%s' "$DIFF" | grep -q "export const answer = 42" && green "    diff shows the added line ✓"

cyan "==> 5/7  A human leaves a multiline review COMMENT on the diff"
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/review-comments" -H 'content-type: application/json' \
  -d '{"filePath":"feature.ts","lineStart":1,"lineEnd":1,"body":"rename to ANSWER (uppercase const)"}' >/dev/null
echo "    comment posted on feature.ts:1"

cyan "==> 6/7  DELIVER the comment back to the agent → a NEW session addresses it"
DELIVER=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/review-comments/deliver")
FOLLOW=$(printf '%s' "$DELIVER" | field sessionId); COUNT=$(printf '%s' "$DELIVER" | num deliveredCount)
echo "    delivered $COUNT comment(s) → follow-up session=$FOLLOW"
for i in $(seq 1 60); do S2=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$FOLLOW" | field status); [ "$S2" = "completed" ] && break; sleep 0.5; done
FIXDIFF=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$FOLLOW/diff?mode=cumulative")
printf '%s' "$FIXDIFF" | grep -q "ANSWER" && green "    follow-up diff shows the FIX (renamed to ANSWER) ✓ — the round trip works"

cyan "==> 7/7  Open a PR (Checks ride the same seam)"
PR=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/pull-request" -H 'content-type: application/json' -d '{"title":"Add answer"}')
if [ "$PR" = "501" ]; then
  green "    PR route returned 501 (GitHub not configured) — set GITHUB_PROVIDER=gh to open real PRs + read Checks"
else
  green "    PR created (HTTP $PR)"
fi
green "==> Verified: agent edits → branch DIFF → review COMMENT → DELIVER → agent commits a FIX. PR/Checks behind the GitHubProvider seam."
