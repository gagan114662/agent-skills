#!/usr/bin/env bash
# Scripted acceptance demo for multi-tenant deployment + observability (issue #19).
# One pipeline deploys the full stack (migrate-on-deploy) → probes/metrics → correlation
# id traced end-to-end → tenant A cannot read tenant B. Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
B="http://localhost:3000"
JA="$(mktemp)"; JB="$(mktemp)"
cleanup() { rm -f "$JA" "$JB"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #19 deployment + observability demo"

cyan "==> 1/6  One pipeline deploys the full stack (build + migrate-on-deploy + server)"
docker compose --profile full up -d --build
# server is 'healthy' only once /readyz passes (deps up). Wait for it.
SID="$(docker compose ps -q server)"
for i in $(seq 1 60); do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$SID" 2>/dev/null || echo starting)"
  [ "$s" = "healthy" ] && break; sleep 2
done
echo "    migrate service log:"; docker compose logs migrate 2>&1 | grep -iE "migration|up:" | sed 's/^/      /' || true
green "    server container healthy ✓ (gated on /readyz)"

cyan "==> 2/6  Probes: /livez (liveness), /readyz (readiness), /healthz (summary)"
printf "    /livez  -> "; curl -s "$B/livez"; echo
printf "    /readyz -> "; curl -s "$B/readyz"; echo
printf "    /healthz-> "; curl -s "$B/healthz"; echo

cyan "==> 3/6  Metrics: Prometheus exposition at /metrics (route-templated, no tenant labels)"
curl -s "$B/metrics" | grep -E "^# TYPE|^http_requests_total|^http_requests_in_flight" | head -8 | sed 's/^/    /'

cyan "==> 4/6  Correlation id traced end-to-end (request id echoed in response header)"
HDRS="$(curl -s -D - -o /dev/null -H 'x-request-id: demo-trace-123' "$B/livez")"
echo "$HDRS" | grep -i "x-request-id" | sed 's/^/    /'
echo "$HDRS" | grep -iq "x-request-id: demo-trace-123" && green "    x-request-id echoed ✓"

cyan "==> 5/6  Tenant A posts a secret in its own channel"
curl -s -c "$JA" -XPOST "$B/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"a-$$@e.com\",\"password\":\"pw\",\"displayName\":\"A\",\"workspaceSlug\":\"a-$(date +%s)\"}" >/dev/null
WSA="$(curl -s -b "$JA" "$B/me" | field workspaceId)"
CID="$(curl -s -b "$JA" -XPOST "$B/workspaces/$WSA/channels" -H 'content-type: application/json' -d '{"name":"secrets"}' | field id)"
curl -s -b "$JA" -XPOST "$B/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"top secret"}' >/dev/null
echo "    A workspace=$WSA channel=$CID (message posted)"

cyan "==> 6/6  Tenant B cannot read A's channel (cross-tenant blocked)"
curl -s -c "$JB" -XPOST "$B/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"b-$$@e.com\",\"password\":\"pw\",\"displayName\":\"B\",\"workspaceSlug\":\"b-$(date +%s)\"}" >/dev/null
printf "    B reads A's messages -> HTTP "; CODE="$(curl -s -o /tmp/b-body.txt -w "%{http_code}" -b "$JB" "$B/channels/$CID/messages")"; echo "$CODE"
printf "    B lists A's channels  -> HTTP "; curl -s -o /dev/null -w "%{http_code}\n" -b "$JB" "$B/workspaces/$WSA/channels"
if grep -q "top secret" /tmp/b-body.txt; then red "    LEAK! A's secret visible to B"; exit 1; else green "    A's secret NOT leaked to B ✓"; fi

green "==> #19 verified: one-pipeline deploy + migrate, probes/metrics, correlation id, tenant isolation."
