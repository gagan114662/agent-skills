#!/usr/bin/env bash
# Team Mode demo harness. One invocation = ONE agent working on its own subtask/branch inside a
# self-contained scratch git repo (TEAM_ORIGIN, a bare repo set by the demo). It:
#   1. emits structured team-event marker lines on stdout — the SessionManager streams each line
#      into the shared team channel, so peers can read them (`::team-event:: <json>`);
#   2. clones the shared origin, creates its branch, writes its OWN distinct file, commits, and
#      pushes the branch back — so all agents' branches merge later with zero conflicts.
#
# The subtask is described in AGENT_TASK as `branch=<b> file=<f> <free text>`. No secrets or auth
# are passed in: the channel is the source of truth and is read by the demo over the REST API.
set -euo pipefail

TASK="${AGENT_TASK:-}"
BRANCH="$(printf '%s' "$TASK" | sed -n 's/.*branch=\([^ ]*\).*/\1/p')"
FILE="$(printf '%s' "$TASK" | sed -n 's/.*file=\([^ ]*\).*/\1/p')"
: "${TEAM_ORIGIN:?TEAM_ORIGIN must be set by the demo}"
: "${TEAM_SCRATCH_DIR:?TEAM_SCRATCH_DIR must be set by the demo}"
[ -n "$BRANCH" ] || { echo "harness: no branch in AGENT_TASK" >&2; exit 1; }
[ -n "$FILE" ] || { echo "harness: no file in AGENT_TASK" >&2; exit 1; }

export TEAM_BRANCH="$BRANCH"

# Emit one team event as a marker line; the SessionManager turns it into a channel message.
emit() {
  TEAM_KIND="$1" TEAM_SUMMARY="$2" node -e '
    console.log("::team-event:: " + JSON.stringify({
      teamRunId: process.env.TEAM_RUN_LABEL || "demo",
      subtaskId: process.env.TEAM_BRANCH,
      agentMemberId: process.env.TEAM_BRANCH,
      kind: process.env.TEAM_KIND,
      summary: process.env.TEAM_SUMMARY,
      branch: process.env.TEAM_BRANCH,
      createdAt: new Date().toISOString(),
    }));
  '
}

WORK="$TEAM_SCRATCH_DIR/wt-${BRANCH//\//-}"
rm -rf "$WORK"

emit started "claimed $BRANCH — working on $FILE"
git clone -q "$TEAM_ORIGIN" "$WORK"
cd "$WORK"
git checkout -q -b "$BRANCH"

emit milestone "writing $FILE on $BRANCH"
{
  echo "# $FILE"
  echo "Implemented on branch $BRANCH by a Team Mode agent."
  echo "Task: $TASK"
} > "$FILE"
git add "$FILE"
git -c user.email="agent@team.demo" -c user.name="Agent ${BRANCH}" commit -q -m "feat(${BRANCH}): add ${FILE}"
git push -q origin "$BRANCH"

emit done "pushed ${FILE} on ${BRANCH} — ready to merge"
echo "agent: completed ${BRANCH}"
