#!/usr/bin/env bash
# Scripted acceptance demo for multi-model / multi-provider selection + effort/Auto mode (issue #52).
#   1) A tenant policy (repo-layer config) allows Anthropic + Bedrock + Vertex, pins a default model,
#      configures the Bedrock region, and an Auto-mode pair (Opus plans -> Sonnet implements). NON-secret.
#   2) Launch a session on Anthropic with a chosen model + high effort -> the model + a thinking budget
#      reach the harness as env (what Claude Code reads natively).
#   3) Launch a session on Bedrock -> the use-bedrock flag is set and NO API key is baked (cloud creds).
#   4) Launch in Auto mode -> TWO distinct models (implement + plan) in one session.
#   5) Prove the policy is the lock: a provider outside the allow-list is refused with a 400.
# The demo harness echoes the selection env it received, so you can SEE exactly what each session ran.
# Run from platform/. Real server, LocalRuntime, no cloud spend, no real model calls.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red() { printf "\033[1;31m%s\033[0m\n" "$*"; }
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

WORK="$(mktemp -d)"; JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK" "$JAR"; }
trap cleanup EXIT

# A cwd-independent harness that echoes the SELECTION env it was given (proves it reached the agent).
cat > "$WORK/selecho.js" <<'EOF'
const e = process.env;
console.log("agent: model=" + (e.ANTHROPIC_MODEL || "none"));
console.log("agent: planModel=" + (e.ANTHROPIC_DEFAULT_OPUS_MODEL || "none"));
console.log("agent: bedrock=" + (e.CLAUDE_CODE_USE_BEDROCK || "none") + " region=" + (e.AWS_REGION || "none"));
console.log("agent: thinking=" + (e.MAX_THINKING_TOKENS || "none"));
console.log("agent: apiKey=" + (e.ANTHROPIC_API_KEY ? "PRESENT" : "none"));
EOF

# The tenant policy (repo-layer, NON-secret): allowed providers + default model + Auto pair + region.
cat > "$WORK/settings.toml" <<'EOF'
[models]
defaultProvider = "anthropic"
defaultModel = "claude-sonnet-4-6"
allowedProviders = ["anthropic", "bedrock", "vertex"]
defaultEffort = "off"
[models.auto]
planModel = "claude-opus-4-8"
implementModel = "claude-sonnet-4-6"
[models.providers.bedrock]
region = "us-east-1"
EOF

cyan "==> Reload — issue #52 multi-model / multi-provider selection demo"

docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null

AGENT_RUNTIME=local AGENT_HARNESS_CMD="$(command -v node)" \
AGENT_HARNESS_ARGS="[\"$WORK/selecho.js\"]" \
RELOAD_REPO_CONFIG="$WORK/settings.toml" \
AGENT_IDLE_MS=8000 AGENT_WALLCLOCK_MS=30000 \
  pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo52-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo52-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" localhost:3000/me | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"dev"}' | field id)
AGENT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}')
AMEM=$(printf '%s' "$AGENT" | field memberId)

# Launch a session, wait for it to finish, then print the harness's echoed selection env.
launch_and_show() {
  local label="$1"; local body="$2"
  cyan "==> $label"
  local res sid
  res=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" -H 'content-type: application/json' -d "$body")
  sid=$(printf '%s' "$res" | field id)
  if [ -z "$sid" ]; then red "    launch rejected: $res"; return 1; fi
  green "    launched (provider=$(printf '%s' "$res" | field provider) model=$(printf '%s' "$res" | field model) effort=$(printf '%s' "$res" | field effort) mode=$(printf '%s' "$res" | field mode))"
  for i in $(seq 1 60); do
    local st; st=$(curl -s -b "$JAR" "localhost:3000/channels/$CID/agent-sessions/$sid" | field status)
    case "$st" in completed|failed|timeout|idle_reaped|canceled) break;; esac
    sleep 0.3
  done
  curl -s -b "$JAR" "localhost:3000/channels/$CID/messages" | grep -oE '"body":"agent: [^"]*"' | cut -d'"' -f4 | sed 's/^/      /'
}

launch_and_show "1/5  Anthropic + claude-opus-4-8 + HIGH effort (model + thinking budget reach the harness)" \
  "{\"agentMemberId\":\"$AMEM\",\"task\":\"summarize the repo\",\"provider\":\"anthropic\",\"model\":\"claude-opus-4-8\",\"effort\":\"high\"}"

launch_and_show "2/5  Bedrock (use-bedrock flag set, region applied, NO API key baked)" \
  "{\"agentMemberId\":\"$AMEM\",\"task\":\"summarize the repo\",\"provider\":\"bedrock\",\"model\":\"claude-sonnet-4-6\"}"

launch_and_show "3/5  Auto mode — TWO distinct models in one session (implement + plan)" \
  "{\"agentMemberId\":\"$AMEM\",\"task\":\"summarize the repo\",\"mode\":\"auto\"}"

launch_and_show "4/5  Default (no selection) — the tenant's pinned default model applies" \
  "{\"agentMemberId\":\"$AMEM\",\"task\":\"summarize the repo\"}"

cyan "==> 5/5  Policy is the lock: a provider outside the allow-list is refused"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -XPOST "localhost:3000/channels/$CID/agent-sessions" \
  -H 'content-type: application/json' -d "{\"agentMemberId\":\"$AMEM\",\"task\":\"x\",\"provider\":\"openai\",\"model\":\"gpt-x\"}")
[ "$CODE" = "400" ] && green "    openai (not in allow-list) -> HTTP 400 ✓" || { red "    expected 400, got $CODE"; exit 1; }

green "==> Done — model/provider/effort/Auto selection works, secrets never baked, policy enforced."
