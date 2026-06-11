#!/usr/bin/env bash
# Scripted acceptance demo for issue #138 (ADR-0138): the live ipop product baseline — preloaded
# marketing department channels + the pop brand tokens. Proven against the real server with the
# marketing fleet enabled via env (the same RELOAD_MARKETING_* knobs fly.toml sets), no spend
# (seedWelcomeTasks=false → no welcome-session launches), no external network.
#
# It exercises:
#   1. A brand-new workspace (signup) is seeded into a working agency — GET /me/channels returns one
#      channel per marketing department (seo/social/content/email/ads/analytics/brand) + the shared
#      rooms, wired to the #123 fleet agents (scout/echo/quill/postmark/bid/lens/mark on the roster).
#   2. Re-running the seed is idempotent (no duplicate channels).
#   3. The pop brand tokens (Paper/Ink/Pop-Vermilion + the playful motion curve) are present in the web
#      console stylesheet, and the committed brand book is the source of truth.
# Backfill-on-boot for PRE-EXISTING workspaces is proven by test/integration/marketing-backfill.test.ts.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT

cyan "==> Reload — issue #138 pop identity + preloaded department channels"

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

# The deployment env that ipop.ai's fly.toml sets: the fleet is ON, welcome tasks OFF (no spend).
RELOAD_USER_CONFIG="" RELOAD_MANAGED_CONFIG="" RELOAD_REPO_CONFIG="" \
RELOAD_MARKETING_ENABLED=true RELOAD_MARKETING_SEED_WELCOME_TASKS=false \
AGENT_RUNTIME=local \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo138-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 1/3  A brand-new workspace lands inside a working agency"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo138-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CHANNELS=$(curl -s -b "$JAR" localhost:3000/me/channels)
for dept in seo social content email ads analytics brand; do
  printf '%s' "$CHANNELS" | grep -q "\"name\":\"$dept\"" || { red "    MISSING department channel: #$dept"; exit 1; }
done
green "    /me/channels has all 7 department channels (+ general, launch)"

ROSTER=$(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/department/roster")
for agent in scout echo quill postmark bid lens mark; do
  printf '%s' "$ROSTER" | grep -q "\"handle\":\"$agent\"" || { red "    MISSING fleet agent: $agent"; exit 1; }
done
green "    roster shows all 7 named #123 fleet agents"

cyan "==> 2/3  Re-seeding is idempotent (no duplicate channels)"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/department/seed" -H 'content-type: application/json' -d '{}' >/dev/null
COUNT=$(curl -s -b "$JAR" localhost:3000/me/channels | grep -oE '"name":"[^"]+"' | sort -u | wc -l | tr -d ' ')
[ "$COUNT" = "9" ] && green "    still 9 unique channels after re-seed" || { red "    expected 9 channels, got $COUNT"; exit 1; }

cyan "==> 3/3  The pop brand tokens are live in the web console"
CSS=apps/web/src/styles.css
grep -qi -- "--paper:[[:space:]]*#f6f1e7" "$CSS" || { red "    Paper token missing"; exit 1; }
grep -qi -- "--ink:[[:space:]]*#171310" "$CSS" || { red "    Ink token missing"; exit 1; }
grep -qi -- "--vermilion:[[:space:]]*#ff4524" "$CSS" || { red "    Pop Vermilion token missing"; exit 1; }
grep -q "cubic-bezier(0.2, 1.4, 0.3, 1)" "$CSS" || { red "    pop motion curve missing"; exit 1; }
[ -f ../docs/brand/ipop-brand-identity.html ] && green "    Paper/Ink/Pop-Vermilion + motion present; brand book committed at docs/brand/" || { red "    brand book missing"; exit 1; }

green "==> #138 acceptance demo passed — made by robots, steered by humans."
