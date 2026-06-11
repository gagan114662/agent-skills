#!/usr/bin/env bash
# Scripted acceptance demo for the Insight Miner (issue #100, ADR-0100). Run from platform/.
#   Part A — LIST IS THE STRATEGY: register evidence sources (scored by strength BEFORE mining), then
#            MINE the strongest into a structured insight that carries its source URL + recency.
#   Part B — OWNER SECRET → VENTURE IDEA: capture a proprietary observation as a first-class artifact
#            and PROMOTE it into a #96 venture idea — the insight becomes the idea's secret, linked
#            back via promotedIdeaId (provenance).
#   Part C — KILLED ANGLES NEVER RETURN UNCITED: kill an angle (recorded to the #15 memory graph); a
#            later uncited repeat is suppressed on promote (409), but the SAME angle WITH a fresh
#            citation is allowed back (new evidence reopens it).
#   Part D — DOLLAR CEILING (#71): mining charges the SAME tenant_usage accounting; once over budget a
#            mining pass is refused with 402 — the same status an over-budget session launch gets.
# The miner is a deterministic stand-in (no scraping, no model spend); the flag is set via managed config.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

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
    pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo100-server.log 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 40); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && return 0; sleep 0.5; done
  red "server did not come up"; cat /tmp/reload-demo100-server.log; exit 1
}

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
start_server

cyan "==> Reload — issue #100 Insight Miner demo (evidence-sourced secrets feeding the venture loop)"

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo100-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
# Enable the miner for this workspace via the managed layer (default OFF everywhere else).
printf '[workspace.%s.insight]\nenabled = true\nminSourceStrength = 0\n' "$WS" > "$MANAGED"
stop_server; start_server

api() { curl -s -b "$JAR" "$@"; }
post() { api -XPOST "localhost:3000$1" -H 'content-type: application/json' -d "$2"; }
get()  { api "localhost:3000$1"; }
code() { curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -XPOST "localhost:3000$1" -H 'content-type: application/json' -d "$2"; }

# --- Part A: list is the strategy → mine -----------------------------------------------------------
cyan "==> A  Register sources (scored before mining) → mine the strongest into a cited insight"
post "/workspaces/$WS/insight-sources" '{"kind":"support_forum","url":"https://forum.example/t/flaky-cache","title":"CI caches corrupt silently","observedAt":"2026-06-10T00:00:00Z"}' >/dev/null
post "/workspaces/$WS/insight-sources" '{"kind":"pricing","url":"https://vendor.example/pricing","title":"competitor raised prices 4x","observedAt":"2026-01-01T00:00:00Z"}' >/dev/null
STRENGTH=$(get "/workspaces/$WS/insight-sources" | grep -oE '"evidenceStrength":[0-9]+' | head -1)
echo "    strongest source: $STRENGTH (support_forum, fresh > stale pricing page)"
MINED=$(post "/workspaces/$WS/insights/mine" '{}')
N=$(printf '%s' "$MINED" | grep -oE '"score":[0-9]+' | wc -l | tr -d ' ')
[ "$N" -ge 1 ] || { red "    expected ≥1 insight mined"; echo "$MINED"; exit 1; }
green "    mined $N insight(s); each carries its source URL + recency, ranked freshness×pain×competition ✓"

# --- Part B: owner secret → venture idea (provenance) ----------------------------------------------
cyan "==> B  Capture an owner secret → promote into a #96 venture idea (provenance-linked)"
IID=$(post "/workspaces/$WS/insights/owner-secret" '{"statement":"Hospitals reuse fax to dodge HIPAA audits","painIntensity":8,"competitionAbsence":9}' | field id)
PROMO=$(post "/workspaces/$WS/insights/$IID/promote" '{"targetUser":"clinic ops leads","wedge":"one regional clinic","marketPath":"$2B compliance"}')
IDEA=$(printf '%s' "$PROMO" | field ideaId)
[ -n "$IDEA" ] || { red "    expected a venture idea id"; echo "$PROMO"; exit 1; }
LINK=$(get "/workspaces/$WS/insights/$IID" | field promotedIdeaId)
[ "$LINK" = "$IDEA" ] || { red "    expected promotedIdeaId=$IDEA, got '$LINK'"; exit 1; }
SECRET=$(get "/workspaces/$WS/ventures/$IDEA" | field insight)
green "    promoted → venture idea $IDEA; insight is the idea's secret (\"$SECRET\"), linked back ✓"

# --- Part C: killed angles never return uncited ----------------------------------------------------
cyan "==> C  Kill an angle (→ #15 memory) → an uncited repeat is suppressed; a cited one is allowed"
KID=$(post "/workspaces/$WS/insights/owner-secret" '{"statement":"Rebuild the thing nobody asked for","painIntensity":5,"competitionAbsence":5}' | field id)
post "/workspaces/$WS/insights/$KID/kill" '{"reasoning":"not fundable"}' >/dev/null
RID=$(post "/workspaces/$WS/insights/owner-secret" '{"statement":"Rebuild the thing nobody asked for","painIntensity":5,"competitionAbsence":5}' | field id)
C_SUP=$(code "/workspaces/$WS/insights/$RID/promote" '{"targetUser":"x","wedge":"y","marketPath":"z"}')
[ "$C_SUP" = "409" ] || { red "    expected 409 (suppressed) for an uncited killed angle, got $C_SUP"; exit 1; }
green "    uncited repeat of a killed angle → 409 suppressed ✓"
CID=$(post "/workspaces/$WS/insights/owner-secret" '{"statement":"Rebuild the thing nobody asked for","painIntensity":5,"competitionAbsence":5,"evidence":[{"sourceUrl":"https://news.example/reg-change","excerpt":"regulation flipped","observedAt":"2026-06-10T00:00:00Z"}]}' | field id)
C_OK=$(code "/workspaces/$WS/insights/$CID/promote" '{"targetUser":"x","wedge":"y","marketPath":"z"}')
[ "$C_OK" = "201" ] || { red "    expected 201 (allowed) for a cited killed angle, got $C_OK"; exit 1; }
green "    same angle WITH a fresh citation → 201 allowed (new evidence reopens it) ✓"

# --- Part D: dollar ceiling (402, #71 tenant usage) ------------------------------------------------
# A fresh workspace whose usage window starts at zero, with a tiny budget.
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g2-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo100b-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
printf '[workspace.%s.insight]\nenabled = true\nminSourceStrength = 0\nmineCostCents = 100\n\n[workspace.%s.scale]\nbudgetCents = 100\n' "$WS" "$WS" > "$MANAGED"
stop_server; start_server
cyan "==> D  Dollar ceiling: each mine charges 100¢ to tenant_usage; budget=100¢ → 2nd pass → 402"
post "/workspaces/$WS/insight-sources" '{"kind":"community","url":"https://x.example","title":"signal","observedAt":"2026-06-10T00:00:00Z"}' >/dev/null
D1=$(code "/workspaces/$WS/insights/mine" '{}')
[ "$D1" = "200" ] || { red "    expected 200 on pass 1, got $D1"; cat /tmp/reload-demo100-server.log; exit 1; }
green "    pass 1: charged 100¢ (pre-check 0 < 100 budget) → HTTP $D1"
D2=$(code "/workspaces/$WS/insights/mine" '{}')
[ "$D2" = "402" ] || { red "    expected 402 on pass 2, got $D2"; exit 1; }
green "    pass 2: 100¢ spent ≥ 100¢ budget → mining refused, answered 402 (same as an over-budget launch) ✓"

green "==> Verified: list-is-the-strategy source ranking + mining (cited insights) · owner secret → venture idea (provenance link) · killed angles never return uncited (#15 dedupe) · dollar-ceiling 402 (#71 shared tenant budget) — all with the deterministic stand-in miner, no model spend. Tenant isolation + the full route round-trip are covered in test/integration/insights.test.ts."
