#!/usr/bin/env bash
# Demo agent harness (issue #25). Model-agnostic stand-in for a real coding agent: it reads the
# task from $AGENT_TASK and emits a few lines of "work" with small delays, then exits 0. The
# AgentRuntime streams these lines into the channel — proving "close the laptop, agents keep
# working" without depending on any specific model/SDK. A real harness (Claude, Codex, …) is a
# drop-in replacement via AGENT_HARNESS_CMD / AGENT_HARNESS_ARGS.
set -euo pipefail

TASK="${AGENT_TASK:-(no task provided)}"

echo "agent: picked up task: ${TASK}"
sleep 0.3
# Demonstrates secret redaction: the value is injected as env at provision; the runtime scrubs
# it from streamed output + logs, so the channel only ever sees the mask.
echo "agent: using credential ${DEMO_SECRET:-none}"
sleep 0.3
echo "agent: analyzing the request…"
sleep 0.3
echo "agent: drafting a plan (1) read (2) change (3) verify"
sleep 0.3
echo "agent: working… still going after the client disconnected"
sleep 0.3
echo "agent: done — result: completed '${TASK}'"
