#!/usr/bin/env bash
# Scripted acceptance demo for agent-operated disaster recovery (#99, ADR-0049).
#  1. Flip INSTANT maintenance mode ON  → a write is rejected (503), a read still succeeds (200).
#  2. Flip maintenance OFF              → writes resume immediately (no redeploy).
#  3. Run the VALIDATION drill          → dump the live DB, restore into a THROWAWAY DB, and verify
#                                         counts + schema + freshness + content checksums (loud pass/fail).
# No cloud spend: the drill uses the local dryrun object store. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

JAR="$(mktemp)"
SERVER_PID=""
cleanup() {
  # Always leave maintenance OFF, even if the demo aborts midway.
  curl -s -b "$JAR" -XPOST localhost:3000/maintenance -H 'content-type: application/json' -d '{"on":false}' >/dev/null 2>&1 || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$JAR"
}
trap cleanup EXIT

cyan "==> Reload — disaster recovery demo (instant maintenance mode + restore validation drill)"

cyan "==> 1/6  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo43-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/6  Human signup (a write — done BEFORE maintenance)"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo43-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
echo "    workspace=$WS"

cyan "==> 3/6  Flip maintenance ON (instant, no redeploy)"
ON=$(curl -s -b "$JAR" -XPOST localhost:3000/maintenance -H 'content-type: application/json' -d '{"on":true,"reason":"DR demo"}')
echo "    $ON"

cyan "==> 4/6  A write is rejected (503); a read still succeeds (200)"
WCODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"blocked"}')
RCODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" localhost:3000/me)
echo "    POST /workspaces/$WS/channels → $WCODE   GET /me → $RCODE"
[ "$WCODE" = "503" ] && [ "$RCODE" = "200" ] || { red "    expected write=503 read=200"; exit 1; }
green "    writes paused, reads flowing ✓"

cyan "==> 5/6  Flip maintenance OFF → writes resume immediately"
curl -s -b "$JAR" -XPOST localhost:3000/maintenance -H 'content-type: application/json' -d '{"on":false}' >/dev/null
WCODE2=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"resumed"}')
echo "    POST /workspaces/$WS/channels → $WCODE2"
[ "$WCODE2" -lt 400 ] || { red "    expected the write to resume"; exit 1; }
green "    writes resumed ✓"

cyan "==> 6/6  VALIDATION drill: dump → restore (throwaway) → verify (non-destructive)"
if pnpm --filter @reload/server dr:drill; then
  green "    restore verified against the live source ✓"
else
  red "    drill FAILED — the dump/restore pipeline is broken"; exit 1
fi

green "==> Verified: maintenance mode pauses writes in seconds (fail-open), and the latest dump restores + verifies clean."
