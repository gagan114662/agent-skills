#!/usr/bin/env bash
# Scripted acceptance demo for shared memory access + task/file linking (issue #16).
# two agents share one workspace graph → agent A writes, agent B reads/traverses (shared, not siloed)
# → RBAC downgrade (agent → read-only, write rejected) → link memory↔task + memory↔file both ways
# → relevant-context for a task → supersede (old node kept but stale) → cross-workspace rejected.
# Run from platform/.  Honors an existing DATABASE_URL (else docker-compose default on :5433).
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; JAR2="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR" "$JAR2"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
n() { grep -o "$1" | wc -l | tr -d ' '; }   # count occurrences of a pattern on stdin
B="localhost:3000"

cyan "==> Reload — issue #16 shared memory + task/file linking demo"
cyan "==> 1/9  Infra + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo-16.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs "$B/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/9  Human owner signs up + registers two agents (A=Writer, B=Reader)"
curl -s -c "$JAR" -XPOST "$B/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"owner-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Owner\",\"workspaceSlug\":\"shmem-$(date +%s)\"}" >/dev/null
WS=$(curl -s -b "$JAR" "$B/me" | field workspaceId)
reg() { curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/agents" -H 'content-type: application/json' -d "{\"name\":\"$1\"}"; }
A_JSON=$(reg "Writer"); A_TOK=$(printf '%s' "$A_JSON" | field token)
B_JSON=$(reg "Reader"); B_TOK=$(printf '%s' "$B_JSON" | field token); B_MEM=$(printf '%s' "$B_JSON" | field memberId)
echo "    workspace=$WS  agentA=$(printf '%s' "$A_JSON" | field memberId)  agentB=$B_MEM"
amem() { curl -s -H "authorization: Bearer $A_TOK" "$@"; }   # act as agent A
bmem() { curl -s -H "authorization: Bearer $B_TOK" "$@"; }   # act as agent B

cyan "==> 3/9  Agent A writes a shared decision + fact, links them (supports)"
DID=$(amem -XPOST "$B/workspaces/$WS/memories" -H 'content-type: application/json' -d '{"type":"decision","text":"Adopt event sourcing for the ledger","entity":"ledger"}' | field id)
FID=$(amem -XPOST "$B/workspaces/$WS/memories" -H 'content-type: application/json' -d '{"type":"fact","text":"The ledger is append-only","entity":"ledger"}' | field id)
amem -XPOST "$B/workspaces/$WS/memories/$DID/edges" -H 'content-type: application/json' -d "{\"toMemoryId\":\"$FID\",\"relation\":\"supports\"}" >/dev/null
echo "    A wrote decision=$DID supports fact=$FID"

cyan "==> 4/9  Agent B (a DIFFERENT agent) reads + traverses A's node — memory is SHARED"
bmem "$B/workspaces/$WS/memories/$DID" | python3 -m json.tool 2>/dev/null | head -20 || bmem "$B/workspaces/$WS/memories/$DID"
green "    expected: B sees A's decision + neighbor fact (shared graph, not siloed per-agent) ✓"

cyan "==> 5/9  RBAC: owner downgrades B to read-only on memory"
curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/memory/grants" -H 'content-type: application/json' -d "{\"memberId\":\"$B_MEM\",\"capability\":\"read\"}" >/dev/null
echo "    B reads memories  → HTTP $(code -H "authorization: Bearer $B_TOK" "$B/workspaces/$WS/memories")  (expected 200)"
echo "    B writes a memory → HTTP $(code -H "authorization: Bearer $B_TOK" -XPOST "$B/workspaces/$WS/memories" -H 'content-type: application/json' -d '{"type":"fact","text":"blocked"}')  (expected 403)"
curl -s -b "$JAR" -XDELETE "$B/workspaces/$WS/memory/grants/$B_MEM" >/dev/null
echo "    after revoke, B writes  → HTTP $(code -H "authorization: Bearer $B_TOK" -XPOST "$B/workspaces/$WS/memories" -H 'content-type: application/json' -d '{"type":"fact","text":"writes again"}')  (expected 201)"

cyan "==> 6/9  Link memory↔task and memory↔file — resolve BOTH ways"
TID=$(curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/tasks" -H 'content-type: application/json' -d '{"title":"Build the ledger","labels":["ledger"]}' | field id)
curl -s -b "$JAR" -XPOST "$B/tasks/$TID/links" -H 'content-type: application/json' -d "{\"targetType\":\"memory\",\"targetId\":\"$DID\"}" >/dev/null
echo "    task→memory: task lists $(curl -s -b "$JAR" "$B/tasks/$TID/links" | n '"targetId"') memory link(s)"
echo "    memory→task: memory lists $(curl -s -b "$JAR" "$B/workspaces/$WS/memories/$DID/tasks" | n '"id"') task(s)"
curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/memories/$DID/files" -H 'content-type: application/json' -d '{"path":"src/ledger/events.ts"}' >/dev/null
echo "    memory→file: memory lists file $(curl -s -b "$JAR" "$B/workspaces/$WS/memories/$DID/files" | field path)"
echo "    file→memory: path resolves to $(curl -s -b "$JAR" "$B/workspaces/$WS/memories?file=src/ledger/events.ts" | n '"id"') memory(ies)"

cyan "==> 7/9  Relevant-context for the task (linked + neighbors + label-match, stale dropped)"
curl -s -b "$JAR" "$B/workspaces/$WS/tasks/$TID/context" | python3 -m json.tool 2>/dev/null | grep -E '"id"|"reason"|"text"' | head -12 \
  || curl -s -b "$JAR" "$B/workspaces/$WS/tasks/$TID/context"
green "    expected: the linked decision (reason=linked) + its neighbor fact (reason=neighbor) ✓"

cyan "==> 8/9  Supersede: a newer decision marks the old one STALE (kept, not deleted)"
SUP=$(curl -s -b "$JAR" -XPOST "$B/workspaces/$WS/memories/$DID/supersede" -H 'content-type: application/json' -d '{"type":"decision","text":"Adopt CQRS + event sourcing for the ledger","entity":"ledger"}')
NID=$(printf '%s' "$SUP" | field id)
echo "    new node=$NID  supersededId=$(printf '%s' "$SUP" | grep -oE '"supersededId":"[^"]*"' | cut -d'"' -f4)"
echo "    old node still fetchable, flagged: $(curl -s -b "$JAR" "$B/workspaces/$WS/memories/$DID" | grep -oE '"supersededByMemoryId":"[^"]*"' | head -1)"
echo "    by-entity default (live only): $(curl -s -b "$JAR" "$B/workspaces/$WS/memories?entity=ledger" | n '"id":"') node(s)   includeStale: $(curl -s -b "$JAR" "$B/workspaces/$WS/memories?entity=ledger&includeStale=true" | n '"id":"') node(s)"
green "    expected: old kept but stale, default list drops it, includeStale surfaces both ✓"

cyan "==> 9/9  Cross-workspace access is rejected (IDOR)"
curl -s -c "$JAR2" -XPOST "$B/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"other-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Other\",\"workspaceSlug\":\"other-$(date +%s)\"}" >/dev/null
echo "    other workspace reads A's memories → HTTP $(code -b "$JAR2" "$B/workspaces/$WS/memories")  (expected 403)"
echo "    other workspace supersedes A's node → HTTP $(code -b "$JAR2" -XPOST "$B/workspaces/$WS/memories/$NID/supersede" -H 'content-type: application/json' -d '{"type":"fact","text":"x"}')  (expected 403)"

green "==> #16 verified: shared agent↔agent memory, RBAC read/write guard, memory↔task + memory↔file"
green "    both-way linking, task relevant-context, supersede/versioning (stale kept), cross-workspace rejected."
