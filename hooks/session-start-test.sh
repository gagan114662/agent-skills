#!/bin/bash
# session-start-test.sh - Tests for the SessionStart hook JSON payload
#
# Claude Code SessionStart hooks inject context via the documented schema:
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
# This test asserts that schema for both the jq-available and no-jq branches.

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "session-start-test: node not found on PATH — skipping (install Node.js to run this test)" >&2
  exit 0
fi

tmp_payload="$(mktemp)"
trap 'rm -f "$tmp_payload"' EXIT

has_jq=0
if command -v jq >/dev/null 2>&1; then
  has_jq=1
fi

payload="$(bash hooks/session-start.sh)"
printf '%s' "$payload" > "$tmp_payload"

HAS_JQ="$has_jq" PAYLOAD_PATH="$tmp_payload" node <<'NODE'
const fs = require('fs');

const payload = JSON.parse(fs.readFileSync(process.env.PAYLOAD_PATH, 'utf8'));
const hasJq = process.env.HAS_JQ === '1';

const hso = payload.hookSpecificOutput;
if (!hso || typeof hso !== 'object') {
  throw new Error('payload is missing the hookSpecificOutput object (Claude Code ignores other schemas)');
}

if (hso.hookEventName !== 'SessionStart') {
  throw new Error(`expected hookEventName 'SessionStart', got ${hso.hookEventName}`);
}

if (typeof hso.additionalContext !== 'string') {
  throw new Error('hookSpecificOutput.additionalContext must be a string');
}

if (hasJq) {
  if (!hso.additionalContext.includes('agent-skills loaded.')) {
    throw new Error('additionalContext is missing the startup preface');
  }

  if (!hso.additionalContext.includes('# Using Agent Skills')) {
    throw new Error('additionalContext is missing using-agent-skills content');
  }
} else {
  if (!hso.additionalContext.includes('jq is required')) {
    throw new Error('additionalContext is missing jq fallback guidance');
  }
}

console.log('session-start JSON payload OK');
NODE
