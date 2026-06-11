#!/usr/bin/env bash
# Scripted acceptance demo for Moat Accrual (issue #103, ADR-0103). Run from platform/.
#   Part A — RECORD → SCORE: accruals across the four moat dimensions compound a venture's 0–100 moat
#            score (saturating, diminishing returns); breadth beats a single big dump.
#   Part B — STAGNATION FLAG: a second venture that accrues nothing is flagged stagnant in the
#            portfolio roll-up AND surfaced as an attention reason in the #104 Founder Console
#            (flagging gated by moat.enabled — set ON via managed config here).
# No model spend — the moat score is a pure projection of the ledger.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
num() { grep -oE "\"$1\":[0-9.]+" | head -1 | cut -d: -f2; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
stop_server() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  local pids; pids="$(lsof -ti tcp:3000 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  SERVER_PID=""
  for i in $(seq 1 40); do curl -fs localhost:3000/healthz >/dev/null 2>&1 || return 0; sleep 0.25; done
}
cleanup() { stop_server; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

MANAGED="$WORK/managed.toml"; : > "$MANAGED"
start_server() {
  RELOAD_MANAGED_CONFIG="$MANAGED" RELOAD_USER_CONFIG="" RELOAD_REPO_CONFIG="" \
    pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo103-server.log 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 40); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && return 0; sleep 0.5; done
  red "server did not come up"; cat /tmp/reload-demo103-server.log; exit 1
}

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
start_server

cyan "==> Reload — issue #103 Moat Accrual demo (every venture compounds proprietary advantage, measured)"

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo103-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
# Turn moat stagnation flagging ON (default OFF) with a 30-day window.
printf '[workspace.%s.moat]\nenabled = true\nstagnationWindowDays = 30\n' "$WS" > "$MANAGED"
stop_server; start_server

IDEA='{"problem":"p","targetUser":"u","insight":"i","wedge":"w","marketPath":"m"}'
submit() { curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/ventures" -H 'content-type: application/json' -d "$IDEA" | field id; }
accrue() { curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/ventures/$1/moat" -H 'content-type: application/json' -d "$2"; }
moatv()  { curl -s -b "$JAR" "localhost:3000/workspaces/$WS/ventures/$1/moat"; }
console(){ curl -s -b "$JAR" "localhost:3000/workspaces/$WS/founder-console"; }

# --- Part A: RECORD → SCORE ------------------------------------------------------------------------
cyan "==> A  Record accruals across the four dimensions → the moat score compounds"
ALIVE=$(submit)
S0=$(moatv "$ALIVE" | num score); echo "    score before any accrual: ${S0}"
accrue "$ALIVE" '{"dimension":"proprietaryData","magnitude":40,"unit":"rows","provenance":"pipeline:ingest"}' >/dev/null
accrue "$ALIVE" '{"dimension":"switchingCosts","magnitude":20,"unit":"workflows","provenance":"feature:automations"}' >/dev/null
accrue "$ALIVE" '{"dimension":"accumulatedEvals","magnitude":15,"unit":"evals","provenance":"eval-suite"}' >/dev/null
S1=$(moatv "$ALIVE" | num score)
STAG=$(moatv "$ALIVE" | grep -oE '"stagnant":(true|false)' | head -1 | cut -d: -f2)
awk "BEGIN{exit !($S1 > ${S0:-0})}" || { red "    expected score to grow, got $S0 → $S1"; exit 1; }
[ "$STAG" = "false" ] || { red "    expected not stagnant after fresh accruals, got stagnant=$STAG"; exit 1; }
green "    score after 3 accruals: ${S1} (was ${S0}); stagnant=false — the moat is compounding ✓"

# --- Part B: STAGNATION FLAG -----------------------------------------------------------------------
cyan "==> B  A venture that accrues nothing is flagged stagnant in the portfolio + Founder Console"
DORMANT=$(submit)
DSTAG=$(moatv "$DORMANT" | grep -oE '"stagnant":(true|false)' | head -1 | cut -d: -f2)
[ "$DSTAG" = "true" ] || { red "    expected the zero-accrual venture to be stagnant, got $DSTAG"; exit 1; }
C=$(console)
FLAGGED=$(printf '%s' "$C" | grep -oE '"flaggedStagnant":[0-9]+' | head -1 | cut -d: -f2)
[ "${FLAGGED:-0}" = "1" ] || { red "    expected 1 flagged-stagnant venture in the console, got ${FLAGGED:-0}"; echo "$C"; exit 1; }
printf '%s' "$C" | grep -q "stagnant moat (no accrual in 30d)" || { red "    expected the moat attention reason"; echo "$C"; exit 1; }
green "    Founder Console: flaggedStagnant=1 + attention reason \"...stagnant moat (no accrual in 30d)\" ✓"

green "==> Verified: accruals compound a 0–100 moat score (pure, no model spend) · a zero-accrual venture is flagged stagnant in the portfolio AND surfaced for attention in the #104 Founder Console — the pivot/kill signal #107 acts on."
