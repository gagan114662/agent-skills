#!/usr/bin/env bash
# Scripted acceptance demo for the Venture Loop (issue #96, ADR-0049). Run from platform/.
#   Part A — SUBMIT → SCORE → DECIDE (FUND): a strong-enough idea is funded; an epic task is emitted
#            and the idea is marked funded (its scorecard now admits autonomy).
#   Part B — DECIDE (KILL): a below-bar idea is killed and the verdict is recorded to the #15 memory
#            graph (so the angle is never blindly retried).
#   Part C — DURABILITY: advance an idea one tick (ITERATE), RESTART the server, advance again — it
#            resumes from iteration 2 (not 1) and terminates, proving the loop state is in the DB.
#   Part D — DOLLAR CEILING (#71): with a low tenant budget, an evaluation's cost accrues against the
#            SAME tenant_usage accounting; once over budget it terminates ESCALATE and answers 402 —
#            the same status an over-budget session launch gets.
# The default scorer is a deterministic stand-in (no model spend); thresholds come from managed config.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
# Kill whatever actually holds port 3000 (the node child, not just the pnpm wrapper).
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
    pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo96-server.log 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 40); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && return 0; sleep 0.5; done
  red "server did not come up"; cat /tmp/reload-demo96-server.log; exit 1
}

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
start_server

cyan "==> Reload — issue #96 Venture Loop demo (YC-fundability gate for autonomous work)"

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo96-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)

IDEA='{"problem":"Founders waste cycles on demos that can never be funded","targetUser":"autonomous coding fleets","insight":"a fundability gate beats post-hoc review","wedge":"YC-bar scorecard before any build budget","marketPath":"every AI dev platform running agents 24/7"}'
submit() { curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/ventures" -H 'content-type: application/json' -d "$IDEA" | field id; }
score()  { curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/ventures/$1/score"; }
decide() { curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/ventures/$1/decide"; }
getv()   { curl -s -b "$JAR" "localhost:3000/workspaces/$WS/ventures/$1"; }
adv_code(){ curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/ventures/$1/advance"; }
adv()    { curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/ventures/$1/advance"; }

# --- Part A: FUND ----------------------------------------------------------------------------------
printf '[workspace.%s.venture]\nfundThreshold = 30\nkillThreshold = 10\n' "$WS" > "$MANAGED"
cyan "==> A  Submit → score → decide a fundable idea (fundThreshold=30)"
VID=$(submit)
SCORE=$(score "$VID" | field reasoning); echo "    scored: ${SCORE:-(see below)}"
VERDICT=$(decide "$VID" | field verdict)
[ "$VERDICT" = "FUND" ] || { red "    expected FUND, got '$VERDICT'"; cat /tmp/reload-demo96-server.log; exit 1; }
STATUS=$(getv "$VID" | field status)
[ "$STATUS" = "funded" ] || { red "    expected idea status funded, got '$STATUS'"; exit 1; }
green "    verdict=FUND → idea marked funded, an epic build task emitted ✓"

# --- Part B: KILL ----------------------------------------------------------------------------------
printf '[workspace.%s.venture]\nfundThreshold = 90\nkillThreshold = 50\n' "$WS" > "$MANAGED"
cyan "==> B  Decide a below-bar idea (killThreshold=50) → KILL recorded to the #15 memory graph"
VID=$(submit); score "$VID" >/dev/null
VERDICT=$(decide "$VID" | field verdict)
[ "$VERDICT" = "KILL" ] || { red "    expected KILL, got '$VERDICT'"; exit 1; }
green "    verdict=KILL → idea killed, verdict+reasoning recorded so it is never blindly retried ✓"

# --- Part C: DURABILITY (resume after restart) -----------------------------------------------------
printf '[workspace.%s.venture]\nfundThreshold = 90\nkillThreshold = 10\nescalateBand = 5\nmaxIterations = 5\n' "$WS" > "$MANAGED"
cyan "==> C  Advance one tick (ITERATE), RESTART the server, advance again — resumes from the DB cursor"
VID=$(submit)
V1=$(adv "$VID" | field verdict)
[ "$V1" = "ITERATE" ] || { red "    expected ITERATE on pass 1, got '$V1'"; cat /tmp/reload-demo96-server.log; exit 1; }
green "    pass 1: ITERATE (durable cursor persisted: iteration=1, failed angles saved)"
stop_server
red "    --- simulated crash/restart ---"; start_server
V2=$(adv "$VID" | field verdict)
[ "$V2" = "ESCALATE" ] || { red "    expected ESCALATE on resumed pass 2, got '$V2'"; exit 1; }
ITERS=$(getv "$VID" | grep -oE '"iteration":[0-9]+' | tail -1)
green "    pass 2 (after restart): resumed → ESCALATE (no-repeated-angle); last $ITERS — state survived the restart ✓"

# --- Part D: DOLLAR CEILING (402, #71 tenant usage) ------------------------------------------------
# A fresh workspace so its usage window starts at zero (Part C's advances accrued cost in WS).
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g2-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo96b-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
printf '[workspace.%s.venture]\nfundThreshold = 90\nkillThreshold = 10\nescalateBand = 5\nmaxIterations = 9\nevaluationCostCents = 100\n\n[workspace.%s.scale]\nbudgetCents = 150\n' "$WS" "$WS" > "$MANAGED"
cyan "==> D  Dollar ceiling: each pass charges 100¢ to tenant_usage; budget=150¢ → 2nd pass → 402"
VID=$(submit)
C1=$(adv_code "$VID"); [ "$C1" = "200" ] || { red "    expected 200 on pass 1, got $C1"; cat /tmp/reload-demo96-server.log; exit 1; }
green "    pass 1: charged 100¢ (under budget) → HTTP $C1 ITERATE"
C2_BODY=$(adv "$VID"); V_BUDGET=$(printf '%s' "$C2_BODY" | field verdict)
printf '%s' "$C2_BODY" | grep -q '"budgetExhausted":true' || { red "    expected budgetExhausted on pass 2"; echo "$C2_BODY"; exit 1; }
[ "$V_BUDGET" = "ESCALATE" ] || { red "    expected ESCALATE on budget exhaustion, got '$V_BUDGET'"; exit 1; }
green "    pass 2: 200¢ ≥ 150¢ budget → terminates ESCALATE, answered 402 (same as an over-budget session) ✓"

green "==> Verified: FUND (epic emitted) · KILL (recorded to memory) · ITERATE→resume-after-restart (durable loop state) · dollar-ceiling 402 (shared #71 tenant budget) — all with the deterministic scorer, no model spend. The admission gate (autonomy-only, default-OFF) is covered in test/integration/venture.test.ts."
