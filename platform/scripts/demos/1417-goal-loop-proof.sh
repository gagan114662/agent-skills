#!/usr/bin/env bash
set -euo pipefail

echo "Goal-loop proof demo: agentic loop must verify, persist state, and decide next move"
echo
echo "This proves the control-plane gate for: goal -> action -> automated verification -> state -> next move."
echo "It does not claim first-customer revenue or external provider proof."
echo

PROOF="$(mktemp)"
cat > "$PROOF" <<'JSON'
{
  "goal": {
    "id": "goal_123",
    "statement": "Build the autonomous marketing loop until production proof passes.",
    "owner": "workspace",
    "createdAt": "2026-06-28T17:30:00.000Z"
  },
  "automation": {
    "cadence": "event_driven",
    "triggerReceipt": "run:goal-loop:123",
    "repeatCount": 3
  },
  "verification": {
    "automated": true,
    "command": "pnpm -C platform --filter @reload/server goal-loop:proof -- --file proof.json",
    "lastRunAt": "2026-06-28T17:31:00.000Z",
    "lastResult": "pass",
    "receipt": "artifact:goal-loop-proof-123"
  },
  "state": {
    "persisted": true,
    "store": "github_issue",
    "stateRef": "issue:403#goal-loop-state",
    "survivesRestart": true
  },
  "budget": {
    "maxTurns": 12,
    "maxTokens": 120000,
    "retryPolicy": "retry_with_backoff"
  },
  "seniorTools": {
    "rootCauseLogged": true,
    "blockersNamed": true,
    "escalationPath": "GitHub issue comment with owner-visible blocker and next move"
  },
  "nextMove": {
    "decision": "continue",
    "reason": "Verifier passed for the loop primitive; continue to provider-backed customer proof.",
    "nextGoalId": "goal_124"
  }
}
JSON

pnpm --filter @reload/server goal-loop:proof -- --file "$PROOF"

echo
echo "Negative proof: manual prompting and unpersisted state must fail."
BAD_PROOF="$(mktemp)"
cat > "$BAD_PROOF" <<'JSON'
{
  "goal": { "id": "goal_bad", "statement": "Keep asking the owner what to do.", "owner": "workspace", "createdAt": "2026-06-28T17:30:00.000Z" },
  "automation": { "cadence": "manual", "triggerReceipt": "", "repeatCount": 1 },
  "verification": { "automated": false, "command": "", "lastRunAt": "", "lastResult": "fail", "receipt": "" },
  "state": { "persisted": false, "store": "state_file", "stateRef": "", "survivesRestart": false },
  "budget": { "maxTurns": 3, "maxTokens": 3000, "retryPolicy": "retry_until_pass" },
  "seniorTools": { "rootCauseLogged": false, "blockersNamed": false, "escalationPath": "" },
  "nextMove": { "decision": "continue", "reason": "", "nextGoalId": null }
}
JSON

if pnpm --filter @reload/server goal-loop:proof -- --file "$BAD_PROOF"; then
  echo "Expected bad proof to fail" >&2
  exit 1
fi

echo
echo "Video proof complete: manual-prompt loops fail; durable verified loops pass."
