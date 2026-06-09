#!/usr/bin/env bash
# Steerable / plan-aware demo agent harness (issue #53). Model-agnostic stand-in proving plan mode +
# steering without any model spend (dev/CI only). Two behaviors, selected by env (DATA, never argv):
#
#   AGENT_PLAN_MODE=1  → PROPOSE a plan and do NO work: emit a <<<PLAN>>>…<<<END_PLAN>>> block the
#                        server parses (turns/plan.ts parsePlanProposal), then exit. Work blocks until
#                        a human decides (approve / approve-with-feedback / reject).
#   otherwise          → EXECUTE: echo the task, then tail stdin for a short window — each line the
#                        server injects via SessionManager.steer (#53) is echoed as `steer: <text>`,
#                        proving a live redirect — then finish so the session finalizes.
#
# The task is read from $AGENT_TASK (data); steering guidance arrives on stdin (the LocalRuntime pipe).
set -euo pipefail

TASK="${AGENT_TASK:-(no task provided)}"

if [ "${AGENT_PLAN_MODE:-0}" = "1" ]; then
  echo "agent: planning for: ${TASK}"
  echo "<<<PLAN>>>"
  echo "1. read the relevant files"
  echo "2. make the change"
  echo "3. add a test and verify"
  echo "<<<END_PLAN>>>"
  echo "agent: plan proposed — awaiting approval"
  exit 0
fi

echo "agent: executing: ${TASK}"
# Tail stdin for steering guidance. `read -t` returns non-zero on timeout (no more input); `|| true`
# keeps `set -e` happy. The window is short so the session finalizes promptly.
while IFS= read -r -t "${AGENT_STEER_WINDOW:-2}" line; do
  [ -n "${line}" ] && echo "steer: ${line}"
done || true
echo "agent: done — completed '${TASK}'"
