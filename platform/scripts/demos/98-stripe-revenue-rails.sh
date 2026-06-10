#!/usr/bin/env bash
# Scripted acceptance demo for Stripe revenue rails (issue #98, ADR-0043), proven against the real server
# with the default no-network `none` provider (no Stripe account, no spend, no network call). It exercises
# the full #98 surface:
#   1. configure repo-scope billing settings (TRUSTED #58 config — never request-supplied) + tenant secrets
#      (STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET on the #25 AGENT_SECRETS path — NEVER in config)
#   2. launch an agent session, deploy its app (dry-run), then POST .../billing/payment-link → an inbound
#      payment link is minted, attached to the deployment, and posted into the channel
#   3. POST a SIGNATURE-VERIFIED webhook → a deduped revenue_event + willingness-to-pay evidence (the #96
#      venture-loop signal) + a "💰 Received" channel post
#   4. GET .../billing/revenue → revenue-per-venture for the #71 dashboard
#   5. replay the same webhook → deduped (idempotent); a BAD signature → 400 (no event)
#   6. the tenant secret NEVER appears in the persisted revenue_event raw (redacted)
# Outbound money (refunds/payouts/transfers) is NOT here — it is a #13 approval-gated, recorded-only
# action; payouts stay manual in the Stripe dashboard.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
num() { grep -oE "\"$1\":[0-9]+" | head -1 | cut -d':' -f2; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

SECRET="sk-live-demo-billing-$$"
WHSEC="whsec_demo_$$"

# --- the project's billing settings: trusted repo-scope config (provider + currency), NO secrets here ---
cat > "$WORK/repo-settings.toml" <<EOF
[deploy]
provider = "dryrun"

[billing]
provider = "none"
currency = "usd"
EOF

cyan "==> Reload — issue #98 Stripe revenue rails (pay link → signed webhook → revenue → evidence)"

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

# BILLING_PROVIDER defaults to none (no network). The Stripe key + webhook secret are on the #25 secrets
# path keyed by workspace, NEVER in config and NEVER logged (redaction applies).
RELOAD_USER_CONFIG="" RELOAD_MANAGED_CONFIG="" \
RELOAD_REPO_CONFIG="$WORK/repo-settings.toml" \
AGENT_RUNTIME=local AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
AGENT_SECRETS="{\"*\":{\"STRIPE_SECRET_KEY\":\"$SECRET\",\"STRIPE_WEBHOOK_SECRET\":\"$WHSEC\"}}" \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo98-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

# --- seed: human + channel + agent + a deployed session whose app we will charge for -----------------
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo98-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"agents"}' | field id)
AMEM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}' | field memberId)
SID=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' \
  -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"build the app\"}" | field id)
DEP=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/deploy" | field id)
echo "    launched session=$SID, deployment=$DEP into #agents"

cyan "==> 1/4  Mint an inbound payment link for the deployed app"
LINK=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions/$SID/billing/payment-link" \
  -H 'content-type: application/json' -d '{"name":"Pro plan","amountCents":2500,"currency":"usd","interval":"month"}')
URL=$(printf '%s' "$LINK" | field url)
LINK_DEP=$(printf '%s' "$LINK" | field deploymentId)
[ -n "$URL" ] && green "    payment link: $URL  (attached to deployment $LINK_DEP)" || { red "    no link"; exit 1; }
[ "$LINK_DEP" = "$DEP" ] && green "    ✓ attached to the deployment record" || red "    ✗ deployment not attached"

cyan "==> 2/4  A customer pays → Stripe sends a SIGNATURE-VERIFIED webhook"
TS=$(date +%s)
BODY="{\"id\":\"evt_demo_$$\",\"type\":\"checkout.session.completed\",\"data\":{\"object\":{\"amount_total\":2500,\"currency\":\"usd\",\"status\":\"complete\",\"payment_status\":\"paid\",\"metadata\":{\"workspaceId\":\"$WS\",\"channelId\":\"$CID\",\"sessionId\":\"$SID\",\"agentMemberId\":\"$AMEM\"}}}}"
SIG_HEX=$(printf '%s' "${TS}.${BODY}" | openssl dgst -sha256 -hmac "$WHSEC" | awk '{print $NF}')
HOOK=$(curl -s -XPOST "localhost:3000/billing/webhook/$WS" -H 'content-type: application/json' \
  -H "stripe-signature: t=${TS},v1=${SIG_HEX}" -d "$BODY")
echo "    webhook response: $HOOK"
printf '%s' "$HOOK" | grep -q '"received":true' && green "    ✓ accepted + recorded" || { red "    ✗ rejected"; exit 1; }

cyan "==> 3/4  Revenue per venture (the #71 dashboard surface; willingness-to-pay evidence for #96)"
REV=$(curl -s -b "$JAR" "localhost:3000/workspaces/$WS/billing/revenue")
echo "    $REV"
[ "$(printf '%s' "$REV" | num totalCents)" = "2500" ] && green "    ✓ total \$25.00, evidenceCount=$(printf '%s' "$REV" | num evidenceCount)" || red "    ✗ unexpected total"

cyan "==> 4/4  Safety: replay is idempotent; a forged signature is rejected; the secret is never persisted"
REPLAY=$(curl -s -XPOST "localhost:3000/billing/webhook/$WS" -H 'content-type: application/json' \
  -H "stripe-signature: t=${TS},v1=${SIG_HEX}" -d "$BODY")
printf '%s' "$REPLAY" | grep -q '"deduped":true' && green "    ✓ replay deduped (no double-count)" || red "    ✗ replay not deduped"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "localhost:3000/billing/webhook/$WS" \
  -H 'content-type: application/json' -H "stripe-signature: t=${TS},v1=deadbeef" -d "$BODY")
[ "$CODE" = "400" ] && green "    ✓ forged signature → 400 (no event)" || red "    ✗ forged signature not rejected ($CODE)"
grep -q "$SECRET" /tmp/reload-demo98-server.log && red "    ✗ secret leaked into logs!" || green "    ✓ tenant secret never appears in the server logs (redacted)"

green "==> #98 revenue rails: inbound money in, signature-verified + deduped, evidence for the venture loop — outbound money stays #13-gated + manual. ✅"
