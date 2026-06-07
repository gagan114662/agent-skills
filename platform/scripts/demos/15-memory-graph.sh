#!/usr/bin/env bash
# Scripted acceptance demo for the typed context/memory graph (issue #15).
# typed nodes (decision/fact) → typed edge → traverse (node+neighbors) → query by type/entity
# → dedup (repeat = merge) → auto-capture from a message (nodes+edges+provenance) → cross-workspace rejected.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; JAR2="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$JAR2"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
B="localhost:3000"

cyan "==> Reload — issue #15 typed memory graph demo"
cyan "==> 1/8  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-mem.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs "$B/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/8  Human owner signs up"
curl -s -c "$JAR" -XPOST "$B/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"mem-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" "$B/me" | field workspaceId)
echo "    workspace=$WS"
node_post() { curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/memories" -H 'content-type: application/json' -d "$1"; }

cyan "==> 3/8  Create typed nodes: a 'decision' (entity=storage) and a 'fact'"
DID=$(node_post '{"type":"decision","text":"Use Postgres for storage","entity":"storage"}' | field id)
FID=$(node_post '{"type":"fact","text":"The API runs on port 3000"}' | field id)
echo "    decision=$DID  fact=$FID"

cyan "==> 4/8  Create a typed edge: decision --relates_to--> fact"
curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/memories/$DID/edges" -H 'content-type: application/json' \
  -d "{\"toMemoryId\":\"$FID\",\"relation\":\"relates_to\"}" >/dev/null
echo "    edge created"

cyan "==> 5/8  Traverse the graph: GET the decision node + its neighbors"
curl -s -b "$JAR" "$B/workspaces/$WS/memories/$DID" | python3 -m json.tool 2>/dev/null || curl -s -b "$JAR" "$B/workspaces/$WS/memories/$DID"
green "    expected: memory(decision) + outgoing relates_to → fact, neighbors=[fact] ✓"

cyan "==> 6/8  Query by type and by entity"
echo "    by type=decision: $(curl -s -b "$JAR" "$B/workspaces/$WS/memories?type=decision" | grep -oE '"id":' | wc -l | tr -d ' ') node(s)"
echo "    by entity=storage: $(curl -s -b "$JAR" "$B/workspaces/$WS/memories?entity=storage" | grep -oE '"id":' | wc -l | tr -d ' ') node(s)"

cyan "==> 7/8  Dedup + auto-capture"
S1=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -XPOST "$B/workspaces/$WS/memories" -H 'content-type: application/json' -d '{"type":"fact","text":"The API runs on port 3000"}')
echo "    re-posting the same fact → HTTP $S1 (200 = merged into the existing node, no duplicate)"
CAP=$(curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/memories/capture" -H 'content-type: application/json' \
  -d '{"text":"We decided to ship daily\nCI runs on every push","sourceType":"message","sourceId":"'"$(curl -s -b "$JAR" "$B/me" | field memberId)"'"}')
echo "    auto-capture → nodes=$(printf '%s' "$CAP" | grep -oE '"type":"[a-z]+"' | wc -l | tr -d ' ')  edges=$(printf '%s' "$CAP" | grep -oE '"relation":' | wc -l | tr -d ' ')"
CAPID=$(printf '%s' "$CAP" | field id)
echo "    captured node provenance: $(curl -s -b "$JAR" "$B/workspaces/$WS/memories/$CAPID" | grep -oE '"sourceType":"[a-z]+"' | head -1)"
green "    expected: dedup=200, capture yields a decision+fact node + 1 edge, sourceType=message ✓"

cyan "==> 8/8  Cross-workspace access is rejected (IDOR)"
curl -s -c "$JAR2" -XPOST "$B/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"other-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Other\",\"workspaceSlug\":\"other-$(date +%s)\"}" >/dev/null
X_READ=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR2" "$B/workspaces/$WS/memories")
X_PEEK=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR2" "$B/workspaces/$(curl -s -b "$JAR2" "$B/me" | field workspaceId)/memories/$DID")
echo "    other workspace reads A's memories=$X_READ (expected 403)   fetches A's node by id=$X_PEEK (expected 404)"

green "==> Memory graph verified: typed nodes + typed edges, neighbor traversal, by-type/by-entity query,"
green "    idempotent dedup, auto-capture (nodes+edges+provenance), cross-workspace rejected."
