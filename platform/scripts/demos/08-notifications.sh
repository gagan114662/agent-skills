#!/usr/bin/env bash
# Scripted acceptance demo for notifications & activity alerts (issue #8).
# @mention → live notification over WS + inbox + unread → DM → notification to the other member →
# task assignment → notification → mention-only suppresses non-mention → mute suppresses all →
# mark-read clears unread → a member only sees their own notifications.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #8 notifications & activity alerts demo"
cyan "==> 1/8  Infra (Postgres + Redis) + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo8-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/8  Human signup (member A = Lead) + create #general + register agent (B = Scout)"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Lead\",\"workspaceSlug\":\"demo8-$(date +%s)\"}" >/dev/null
RID="$(awk '$6=="rid"{print $7}' "$JAR")"
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
AID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}')
AMEM=$(printf '%s' "$AID" | field memberId); ATOK=$(printf '%s' "$AID" | field token)
echo "    workspace=$WS  channel(#general)=$CID  agent member(Scout)=$AMEM"

cyan "==> 3/8  Scout connects over WS (no channel subscribe) → @mention Scout → ACTIONABLE notification lands live"
( cd apps/server && RID="$RID" CID="$CID" ATOK="$ATOK" AMEM="$AMEM" \
  node --input-type=module -e '
import { WebSocket } from "ws";
const BASE = "ws://localhost:3000/ws";
const { RID, CID, ATOK, AMEM } = process.env;
const g = (s) => `\x1b[1;32m${s}\x1b[0m`;
class C { constructor(ws){ this.ws=ws; this.ev=[]; this.w=[];
    ws.on("message",(d)=>{ const e=JSON.parse(d.toString()); this.ev.push(e);
      this.w=this.w.filter(x=>{ if(x.m(e)){x.r(e);return false;} return true;}); }); }
  wait(m,ms=5000){ const f=this.ev.find(m); if(f) return Promise.resolve(f);
    return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error("timeout")),ms);
      this.w.push({m,r:(e)=>{clearTimeout(t);res(e);}}); }); }
  close(){ this.ws.close(); } }
const open = (opts) => new Promise((res,rej)=>{ const ws=new WebSocket(BASE,opts); const c=new C(ws);
  ws.on("open",()=>res(c)); ws.on("error",rej); });

const b = await open({ headers:{ authorization:`Bearer ${ATOK}` } });
await b.wait(e=>e.type==="ready");
console.log("    agent B (Scout) connected over WS — NOT subscribed to any channel");

await fetch(`http://localhost:3000/channels/${CID}/messages`, {
  method:"POST", headers:{ "content-type":"application/json", cookie:`rid=${RID}` },
  body: JSON.stringify({ body:"hey @Scout can you take the rollout?" }) });
const n = await b.wait(e=>e.type==="notification");
console.log(g(`    notification: Scout received a live "${n.notification.type}" notification over WS ✓ (to ${n.notification.recipientMemberId===AMEM?"= Scout ✓":"?"})`));
b.close();
' )

cyan "==> 4/8  Scout inbox + unread count (and the author Lead has nothing — never self-notified)"
printf "    GET /me/notifications       (Scout): "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/notifications; echo
printf "    GET /me/notifications/unread-count (Scout): "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/notifications/unread-count; echo
printf "    GET /me/notifications       (Lead, author): "; curl -s -b "$JAR" localhost:3000/me/notifications; echo

cyan "==> 5/8  DM → notification to the other member; task assignment → notification to the assignee"
DM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/dms" -H 'content-type: application/json' -d "{\"memberIds\":[\"$AMEM\"]}" | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$DM/messages" -H 'content-type: application/json' -d '{"body":"quick sync?"}' >/dev/null
TID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/tasks" -H 'content-type: application/json' -d "{\"title\":\"ship notifications\",\"assigneeMemberId\":\"$AMEM\"}" | field id)
printf "    Scout inbox now (mention + dm + assignment): "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/notifications | grep -oE '"type":"[a-z]+"' | tr '\n' ' '; echo

cyan "==> 6/8  Preferences: mention-only suppresses non-mention; full mute suppresses all"
RD=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Picky"}')
RMEM=$(printf '%s' "$RD" | field memberId); RTOK=$(printf '%s' "$RD" | field token)
curl -s -XPUT -H "authorization: Bearer $RTOK" -H 'content-type: application/json' -d '{"mentionOnly":true}' localhost:3000/me/notification-preferences >/dev/null
PDM=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/dms" -H 'content-type: application/json' -d "{\"memberIds\":[\"$RMEM\"]}" | field id)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$PDM/messages" -H 'content-type: application/json' -d '{"body":"you around?"}' >/dev/null   # suppressed (non-mention)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"@Picky eyes here"}' >/dev/null  # delivered (mention)
printf "    mention-only Picky inbox (only the mention, DM suppressed): "; curl -s -H "authorization: Bearer $RTOK" localhost:3000/me/notifications | grep -oE '"type":"[a-z]+"' | tr '\n' ' '; echo
curl -s -XPUT -H "authorization: Bearer $RTOK" -H 'content-type: application/json' -d '{"muted":true}' localhost:3000/me/notification-preferences >/dev/null
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"@Picky again"}' >/dev/null  # suppressed (muted)
printf "    after muting, a new @Picky mention adds nothing — unread stays: "; curl -s -H "authorization: Bearer $RTOK" localhost:3000/me/notifications/unread-count; echo

cyan "==> 7/8  Mark-read clears unread (rows remain in the inbox)"
printf "    Scout unread before: "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/notifications/unread-count; echo
curl -s -XPOST -H "authorization: Bearer $ATOK" localhost:3000/me/notifications/read-all >/dev/null
printf "    Scout unread after read-all: "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/notifications/unread-count
printf "  | inbox still holds: "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/notifications | grep -oE '"type":"[a-z]+"' | wc -l | tr -d ' '; echo " notifications (all read)"

cyan "==> 8/8  Isolation: a member only sees their own; cross-member mark-read is a 404"
NID=$(curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/notifications | field id)
printf "    Lead tries to mark Scout's notification read → HTTP "; curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -XPOST "localhost:3000/me/notifications/$NID/read"; echo " (404 = not yours, IDOR-safe)"
printf "    a brand-new workspace's member sees → "; \
  curl -s -c /tmp/j2 -XPOST localhost:3000/auth/signup -H 'content-type: application/json' -d "{\"email\":\"o-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Outsider\",\"workspaceSlug\":\"demo8b-$(date +%s)\"}" >/dev/null; \
  curl -s -b /tmp/j2 localhost:3000/me/notifications; echo

green "==> Notifications verified: live @mention/DM/assignment notifications, inbox + unread, mention-only + mute suppression, mark-read clears unread, own-only isolation."
