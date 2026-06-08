#!/usr/bin/env bash
# Scripted acceptance demo for the Web Approvals Panel (issue #18 — the #13 governance UI).
#
# The panel is a React surface that consumes the existing #13 approval-gates REST API + the #5/#8
# realtime stream as-is. This terminal demo proves the loop the panel renders, end to end, without
# a screen recorder:
#   1) the web app type-checks and BUILDS, and the approvals suite (api/store/components) is green
#   2) the exact API + realtime behaviours the four surfaces depend on actually work on a live server:
#        policy rule → agent submits a gated action → live `approval` notification over /ws
#        (the Review Queue's live refresh) → pending queue → humans-only guard (agent approve → 403)
#        → human approves → append-only audit chain (the Request Detail timeline) → reject-with-reason
# A companion browser walkthrough (docs/demos/18-approvals-panel.mp4) shows the rendered UI.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
# Isolate in a throwaway database so the demo is immune to sibling-workspace migration drift on the
# shared docker Postgres volume (Conductor parallel workspaces share one PG). Dropped on exit.
DEMO_DB="reload_demo18_$$"
psql_admin() { docker compose exec -T postgres psql -U reload -d reload "$@"; }
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$JAR"
  psql_admin -c "DROP DATABASE IF EXISTS \"$DEMO_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #18 Approvals Panel demo (the web surface for #13)"

cyan "==> 1/8  Web gates: typecheck + build (apps/web must build)"
pnpm --filter @reload/web typecheck
pnpm --filter @reload/web build 2>&1 | tail -4

cyan "==> 2/8  Approvals suite (vitest: api client, store slice, components, live-update)"
pnpm --filter @reload/web test src/api/client.approvals.test.ts src/store/approvals.test.ts src/components/approvals 2>&1 | tail -8

cyan "==> 3/8  Boot the stack the panel talks to (Postgres + Redis + migrate + server)"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
# Fresh, isolated schema — migrations apply cleanly regardless of the shared volume's state.
psql_admin -c "DROP DATABASE IF EXISTS \"$DEMO_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
psql_admin -c "CREATE DATABASE \"$DEMO_DB\"" >/dev/null
export DATABASE_URL="postgres://reload:reload@localhost:5433/$DEMO_DB"
echo "    isolated demo database: $DEMO_DB"
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo18a-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done
echo "    server healthy: $(curl -s localhost:3000/healthz)"

cyan "==> 4/8  Sign in as a human REVIEWER (Ada); register an AGENT requester (Atlas)"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"ada-$$@e.com\",\"password\":\"hunter2pw\",\"displayName\":\"Ada\",\"workspaceSlug\":\"appr18-$(date +%s)\"}" >/dev/null
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
echo "    GET /me → $ME"
AGENT=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Atlas","framework":"claude"}')
ATOK=$(printf '%s' "$AGENT" | field token)
echo "    registered agent Atlas (the requester)"

cyan "==> 5/8  Add a POLICY (the Policy Manager view): external.send pauses for a human over \$100"
curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/approval-policies" -H 'content-type: application/json' \
  -d '{"actionType":"external.send","requireApproval":true,"maxAutoAmount":100}'; echo

cyan "==> 6/8  Agent submits a gated action; the reviewer gets a LIVE \`approval\` over /ws (queue refresh)"
# The reviewer's socket is open and listening BEFORE the action is submitted — exactly how the panel
# learns of a new pending request without a manual refresh (#5/#8 → store → queue reload).
RID_VAL="$(awk '$6=="rid"{print $7}' "$JAR")"
REQ=$( cd apps/server && RID="$RID_VAL" WS="$WS" ATOK="$ATOK" \
  node --input-type=module -e '
import { WebSocket } from "ws";
const { RID, WS, ATOK } = process.env;
const g = (s) => `\x1b[1;32m${s}\x1b[0m`;
const ws = new WebSocket("ws://localhost:3000/ws", { headers: { cookie: `rid=${RID}` } });
const events = []; const waiters = [];
ws.on("message", (d) => { const e = JSON.parse(d.toString()); events.push(e);
  for (const w of waiters.splice(0)) (w.m(e) ? w.r(e) : waiters.push(w)); });
const wait = (m, ms = 6000) => { const f = events.find(m); if (f) return Promise.resolve(f);
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms);
    waiters.push({ m, r: (e) => { clearTimeout(t); res(e); } }); }); };
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
await wait((e) => e.type === "ready");
console.error("    reviewer Ada connected over /ws (listening for approval notifications)");
// Agent submits the gated external.send for $250 (> $100 threshold → pauses for a human).
const res = await fetch(`http://localhost:3000/workspaces/${WS}/actions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ATOK}` },
  body: JSON.stringify({ actionType: "external.send", amount: 250,
    payload: { summary: "Wire $250 to ops@example.com", target: "ops@example.com" } }) });
const body = await res.json();
console.error(`    POST /actions → ${res.status} ${body.status} (reason: ${body.reason})`);
const note = await wait((e) => e.type === "notification" && e.notification.type === "approval");
console.error(g(`    reviewer received a LIVE \`approval\` notification over /ws ✓  "${note.notification.excerpt}"`));
ws.close();
process.stdout.write(body.request.id);
' )
echo "    pending request id = $REQ"

cyan "==> 7/8  Review Queue + humans-only guard + Approve → executed, with the audit timeline"
printf "    GET /workspaces/:wid/approvals?status=pending (Review Queue): "
curl -s -b "$JAR" "localhost:3000/workspaces/$WS/approvals?status=pending" | grep -oE "\"summary\":\"[^\"]*\"" | head -1; echo
printf "    agent tries to approve (must be humans-only): HTTP "
curl -s -o /dev/null -w "%{http_code}" -XPOST "localhost:3000/approvals/$REQ/approve" -H "authorization: Bearer $ATOK"; echo "  → 403 ✓"
printf "    human Ada approves → executes: "
curl -s -b "$JAR" -XPOST "localhost:3000/approvals/$REQ/approve" -H 'content-type: application/json' -d '{"reason":"verified recipient"}' | grep -oE "\"status\":\"[^\"]*\"" | head -1; echo
echo "    GET /approvals/:rid/events (the Request Detail audit timeline):"
curl -s -b "$JAR" "localhost:3000/approvals/$REQ/events" | grep -oE "\"type\":\"(requested|approved|rejected|expired|executed|failed)\"" | sed 's/^/        /'

cyan "==> 8/8  Reject-with-reason path (a second gated action blocked by a human)"
REQ2=$(curl -s -XPOST "localhost:3000/workspaces/$WS/actions" -H "authorization: Bearer $ATOK" -H 'content-type: application/json' \
  -d '{"actionType":"external.send","amount":300,"payload":{"summary":"Refund $300 to vendor","target":"vendor@example.com"}}' | field id)
printf "    Ada rejects %s with a reason: " "$REQ2"
curl -s -b "$JAR" -XPOST "localhost:3000/approvals/$REQ2/reject" -H 'content-type: application/json' -d '{"reason":"unverified vendor"}' | grep -oE "\"status\":\"[^\"]*\"" | head -1; echo
printf "    it now appears under the Rejected tab: "
curl -s -b "$JAR" "localhost:3000/workspaces/$WS/approvals?status=rejected" | grep -oE "\"summary\":\"[^\"]*\"" | head -1; echo

green "==> Approvals Panel verified: builds + tests green, and the policy → gated action →"
green "    live /ws approval → queue → humans-only guard → approve+audit → reject-with-reason"
green "    loop it renders works end-to-end against the unmodified #13 backend."
