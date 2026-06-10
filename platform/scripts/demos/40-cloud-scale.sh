#!/usr/bin/env bash
# Scripted acceptance demo for cloud scale (issue #71, ADR-0040). Run from platform/.
#   Part A — MULTI-REGION placement: a session is placed in the least-loaded allowed region and the
#            choice is persisted on the session row.
#   Part B — KILL SWITCH (#17): engaging it halts ALL launches (429); resuming admits again.
#   Part C — COST/BUDGET cap: once a tenant's accrued cost meets its budget, new sessions are halted
#            (402) and the usage dashboard surfaces it.
#   Part D — observability: /metrics exposes the scale_* series (warm pool hits/misses, admission
#            denials by reason, sessions by region). The warm-pool fast-bind mechanism is proven in
#            unit tests (a real microVM prewarm provider is a documented follow-up behind the seam).
# Everything runs on LocalRuntime with a node echo harness — NO cloud spend.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

# A node harness that prints the task and exits 0 (a few ms of compute → measurable cost at the rate).
cat > "$WORK/harness.js" <<'EOF'
process.stdout.write("agent: task=" + (process.env.AGENT_TASK || "none") + "\n");
setTimeout(() => process.stdout.write("agent: done\n"), 40);
EOF

# Managed config (per-tenant scale policy). loadConfig() reads this fresh on every request, so we
# write the tenant block AFTER signup (once we know the workspace id) and rewrite it between parts.
MANAGED="$WORK/managed.toml"
: > "$MANAGED"

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

AGENT_RUNTIME=local AGENT_HARNESS_CMD="$(command -v node)" \
AGENT_HARNESS_ARGS="[\"$WORK/harness.js\"]" \
AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
RELOAD_MANAGED_CONFIG="$MANAGED" RELOAD_USER_CONFIG="" RELOAD_REPO_CONFIG="" \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo71-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> Reload — issue #71 cloud scale demo (warm pools, autoscaling, multi-region, cost caps)"

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo71-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)

# launch_code -> prints the HTTP status; launch_id -> prints the session id (on a 202)
launch_code() { curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"$1\"}"; }
launch_id()   { curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"$1\"}" | field id; }
wait_completed() { for i in $(seq 1 60); do S=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$1" | field status); [ "$S" = "completed" ] && return 0; [ "$S" = "failed" ] && return 1; sleep 0.3; done; return 1; }

# --- Part A: multi-region placement -----------------------------------------------------------------
printf '[workspace.%s.scale]\nregions = ["iad1", "sfo1"]\n' "$WS" > "$MANAGED"
cyan "==> A  Multi-region: regions=[iad1,sfo1]; launch a session and read back its placement"
SID=$(launch_id "place me")
wait_completed "$SID" || { red "    session did not complete"; cat /tmp/reload-demo71-server.log; exit 1; }
REGION=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$SID" | field region)
[ "$REGION" = "iad1" ] || { red "    expected placement in iad1, got '$REGION'"; exit 1; }
green "    session placed in least-loaded allowed region: $REGION (persisted on the row) ✓"

# --- Part B: kill switch halts launches -------------------------------------------------------------
cyan "==> B  Kill switch (#17): engage → launch is halted (429 kill_switch); resume → admitted"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/autonomy/kill" >/dev/null
CODE=$(launch_code "while killed")
[ "$CODE" = "429" ] || { red "    expected 429 while killed, got $CODE"; exit 1; }
green "    launch halted by the kill switch: HTTP $CODE ✓"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/autonomy/resume" >/dev/null
SID=$(launch_id "after resume"); wait_completed "$SID" || { red "    post-resume session did not complete"; exit 1; }
green "    resumed: a launch is admitted again and runs to completion ✓"

# --- Part C: cost/budget cap halts new sessions -----------------------------------------------------
printf '[workspace.%s.scale]\nregions = ["iad1", "sfo1"]\nbudgetCents = 1\ncomputeRateCentsPerMinute = 600\n' "$WS" > "$MANAGED"
cyan "==> C  Budget cap: budgetCents=1; one session accrues cost, then new launches are halted (402)"
SID=$(launch_id "burn the budget"); wait_completed "$SID" || { red "    budget-burning session did not complete"; exit 1; }
CODE=$(launch_code "over budget")
[ "$CODE" = "402" ] || { red "    expected 402 once over budget, got $CODE"; cat /tmp/reload-demo71-server.log; exit 1; }
green "    over-budget launch halted: HTTP $CODE ✓"
USAGE=$(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/scale/usage")
echo "    usage: $USAGE"
printf '%s' "$USAGE" | grep -q '"overBudget":true' || { red "    usage endpoint did not surface overBudget"; exit 1; }
green "    the usage dashboard surfaces overBudget=true ✓"

# --- Part D: observability --------------------------------------------------------------------------
cyan "==> D  Metrics: the #19 registry exposes the scale_* series"
METRICS=$(curl -s localhost:3000/metrics)
printf '%s\n' "$METRICS" | grep -E '^scale_(warm_(hits|misses)_total|admission_denied_total|region_sessions_total)' | sed 's/^/    /'
printf '%s' "$METRICS" | grep -q 'scale_admission_denied_total{reason="budget_exceeded"}' || { red "    missing budget-denied metric"; exit 1; }
printf '%s' "$METRICS" | grep -q 'scale_region_sessions_total{region="iad1"}' || { red "    missing region placement metric"; exit 1; }
green "    scale metrics present (warm pool hits/misses, admission denials by reason, region placement) ✓"

green "==> Verified: multi-region placement, the #17 kill switch halting launches, a per-tenant budget cap halting sessions (surfaced on the usage dashboard), and the scale_* metrics — all on LocalRuntime, no cloud spend."
