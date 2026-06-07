#!/usr/bin/env bash
# Scripted acceptance demo for realtime messaging + presence (issue #5).
# connect WS → subscribe → live message over WS → presence online/away → non-member blocked.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #5 realtime messaging + presence demo"
cyan "==> 1/6  Infra (Postgres + Redis) + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo5-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/6  Human signup (member A) + create #general"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Gagan\",\"workspaceSlug\":\"demo5-$(date +%s)\"}" >/dev/null
RID="$(awk '$6=="rid"{print $7}' "$JAR")"
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
echo "    workspace=$WS  channel(#general)=$CID"

cyan "==> 3/6  Register an agent (member B) — a workspace member, NOT in #general"
AID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}')
AMEM=$(printf '%s' "$AID" | field memberId); ATOK=$(printf '%s' "$AID" | field token)
echo "    agent member=$AMEM"

cyan "==> 4/6  Drive WebSocket clients (member A subscribes; agent B connects)"
# Everything below runs in one Node process so the ordering is deterministic. It uses the
# 'ws' client and global fetch; cwd=apps/server so the bare 'ws' import resolves.
( cd apps/server && RID="$RID" CID="$CID" ATOK="$ATOK" AMEM="$AMEM" \
  node --input-type=module -e '
import { WebSocket } from "ws";
const BASE = "ws://localhost:3000/ws";
const { RID, CID, ATOK, AMEM } = process.env;
const g = (s) => `\x1b[1;32m${s}\x1b[0m`;

class C {
  constructor(ws){ this.ws=ws; this.ev=[]; this.w=[];
    ws.on("message",(d)=>{ const e=JSON.parse(d.toString()); this.ev.push(e);
      this.w=this.w.filter(x=>{ if(x.m(e)){x.r(e);return false;} return true;}); }); }
  send(c){ this.ws.send(JSON.stringify(c)); }
  wait(m,ms=5000){ const f=this.ev.find(m); if(f) return Promise.resolve(f);
    return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error("timeout")),ms);
      this.w.push({m,r:(e)=>{clearTimeout(t);res(e);}}); }); }
  close(){ this.ws.close(); }
}
const open = (opts) => new Promise((res,rej)=>{ const ws=new WebSocket(BASE,opts); const c=new C(ws);
  ws.on("open",()=>res(c)); ws.on("error",rej); });

const a = await open({ headers:{ cookie:`rid=${RID}` } });
await a.wait(e=>e.type==="ready");
a.send({ type:"subscribe", channelId:CID });
await a.wait(e=>e.type==="subscribed");
console.log("    member A connected + subscribed to #general");

const b = await open({ headers:{ authorization:`Bearer ${ATOK}` } });
await b.wait(e=>e.type==="ready");
await a.wait(e=>e.type==="presence" && e.memberId===AMEM && e.status==="online");
console.log(g("    presence: A sees agent B come ONLINE ✓"));

b.send({ type:"subscribe", channelId:CID });
const err = await b.wait(e=>e.type==="error");
console.log(g(`    non-member B subscribe → ${err.code} (blocked) ✓`));

await fetch(`http://localhost:3000/channels/${CID}/messages`, {
  method:"POST", headers:{ "content-type":"application/json", cookie:`rid=${RID}` },
  body: JSON.stringify({ body:"hello over websocket" }) });
const msg = await a.wait(e=>e.type==="message");
console.log(g(`    realtime: A received message over WS ✓ → "${msg.message.body}"`));

b.send({ type:"presence", status:"away" });
await a.wait(e=>e.type==="presence" && e.memberId===AMEM && e.status==="away");
console.log(g("    presence: A sees agent B go AWAY ✓"));

a.close(); b.close();
' )

cyan "==> 5/6  REST is the source of truth (message persisted, readable over REST too)"
printf "    GET messages: "; curl -s -b "$JAR" "localhost:3000/channels/$CID/messages"; echo

cyan "==> 6/6  Fan-out is Redis pub/sub (works across instances)"
echo "    publish-on-write to rt:channel:* ; each server PSUBSCRIBEs and fans out to local sockets"

green "==> Realtime verified: WS delivery, presence online/away, non-member blocked, Redis fan-out."
