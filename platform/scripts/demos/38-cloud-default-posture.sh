#!/usr/bin/env bash
# Scripted acceptance demo for the cloud + real-agent posture (issue #69).
#   Part A — the DEFAULT `dev` posture (local/demo) passes preflight with no cloud, binaries, or
#            network (this is what CI runs on).
#   Part B — flipping to `prod` (sandbox + claude-code) with NO Vercel auth FAILS preflight fast,
#            with an actionable, secret-free message — and makes NO cloud call (preflight never does).
#   Part C — a guided enable: supply the auth/harness presence preflight asks for, and the auth +
#            harness checks go green (the "zero → first cloud agent" setup, validated before any run).
#
# Note: preflight validates CONFIGURATION PRESENCE + local availability, never a live round-trip — so
# this demo needs no real Vercel/Anthropic spend. The actual cloud-agent RUN (the .mp4 Gagan approves)
# requires real VERCEL_* + claude auth; this script proves the fail-fast safety rail around it.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan()  { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m%s\033[0m\n" "$*"; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

run_preflight() { # prints report, returns its exit code; never makes a cloud call
  set +e
  OUT="$(pnpm --filter @reload/server preflight 2>/dev/null)"
  CODE=$?
  set -e
  echo "$OUT"
}

cyan "==> Reload — issue #69 cloud + real-agent posture (preflight + profiles)"

# --- Part A: default dev posture passes -------------------------------------------------------------
cyan "==> 1/3  Default profile (dev = local/demo) — should PASS with no cloud/binaries"
set +e
OUT="$(env -u RELOAD_PROFILE -u AGENT_RUNTIME -u AGENT_HARNESS pnpm --filter @reload/server preflight 2>/dev/null)"; CODE=$?
set -e
echo "$OUT"
[ "$CODE" -eq 0 ] || { red "    expected dev preflight to pass (exit 0), got $CODE"; exit 1; }
echo "$OUT" | grep -q 'profile "dev"' || { red "    expected profile dev"; exit 1; }
green "    dev posture ready — exit 0, no cloud call ✓"

# --- Part B: misconfigured prod fails fast ----------------------------------------------------------
cyan "==> 2/3  Flip to prod (sandbox/claude-code) with NO Vercel auth — should FAIL fast"
set +e
OUT="$(env -i PATH="$PATH" RELOAD_PROFILE=prod pnpm --filter @reload/server preflight 2>/dev/null)"; CODE=$?
set -e
echo "$OUT"
[ "$CODE" -ne 0 ] || { red "    expected misconfigured prod to FAIL (non-zero exit)"; exit 1; }
echo "$OUT" | grep -q '✗ vercel-auth' || { red "    expected the vercel-auth check to fail"; exit 1; }
echo "$OUT" | grep -q 'VERCEL_OIDC_TOKEN' || { red "    expected an actionable remedy naming VERCEL_OIDC_TOKEN"; exit 1; }
green "    misconfigured prod blocked BEFORE any cloud call — actionable, secret-free ✓"

# --- Part C: guided enable turns the auth/harness checks green --------------------------------------
cyan "==> 3/3  Guided enable: supply the auth + harness presence preflight asked for"
# A stub `claude` on PATH (presence only — never executed by preflight).
mkdir -p "$WORK/bin"; printf '#!/bin/sh\necho claude\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
set +e
OUT="$(env -i PATH="$WORK/bin:$PATH" \
  RELOAD_PROFILE=prod \
  VERCEL_OIDC_TOKEN="oidc-present" \
  ANTHROPIC_API_KEY="key-present" \
  pnpm --filter @reload/server preflight 2>/dev/null)"; CODE=$?
set -e
echo "$OUT"
echo "$OUT" | grep -q '✓ vercel-auth'   || { red "    expected vercel-auth to pass once OIDC is set"; exit 1; }
echo "$OUT" | grep -q '✓ claude-binary' || { red "    expected claude-binary to pass once on PATH"; exit 1; }
echo "$OUT" | grep -q '✓ claude-auth'   || { red "    expected claude-auth to pass once a key is set"; exit 1; }
green "    auth + harness checks green — the prod posture is validated before any run ✓"

echo
green "==> #69 acceptance demonstrated:"
green "    • default dev posture passes preflight (CI-safe, no cloud)"
green "    • misconfigured prod fails fast with an actionable, secret-free message (no cloud call)"
green "    • a guided enable turns the checks green — zero → ready-for-first-cloud-agent"
cyan  "    (the live cloud-agent RUN needs real VERCEL_* + claude auth — recorded for Gagan's video)"
