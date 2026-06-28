#!/usr/bin/env bash
set -euo pipefail

echo "PR #1416 demo: live marketing-agent sessions appear in the signed-in ipop room"
echo
echo "Proof target:"
echo "  - Scout, Quill, and Codex/operator live sessions are read from current-channel state."
echo "  - The Everyday room projects those sessions into visible lane status and task copy."
echo "  - The CMO readout headline names the working room agents."
echo

pnpm --filter @reload/web exec vitest run \
  src/components/everyday/LiveEverydayShell.test.tsx \
  -t "projects current-channel live marketing agents into the signed-in room data" \
  --reporter=verbose

echo
echo "Video proof complete: the signed-in room uses live session state, not a static scaffold."
