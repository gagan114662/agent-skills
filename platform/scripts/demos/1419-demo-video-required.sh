#!/usr/bin/env bash
set -euo pipefail

echo "Demo-video required proof"
echo
echo "This proves selected PR video demos are enforced instead of best-effort."
echo

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKFLOW="$REPO_ROOT/.github/workflows/platform-ci.yml"

if grep -n 'continue-on-error: true' "$WORKFLOW"; then
  echo "demo-video must not continue on error" >&2
  exit 1
fi

if grep -n 'failed (non-blocking)' "$WORKFLOW"; then
  echo "demo recording failures must not be swallowed" >&2
  exit 1
fi

grep -n 'Fails when a selected proof demo cannot be recorded' "$WORKFLOW"
grep -n 'bash scripts/record-demo.sh "$slug"' "$WORKFLOW"
grep -n 'test -s "docs/demos/$slug.mp4"' "$WORKFLOW"

echo
echo "Video proof gate is mandatory for selected demos."
