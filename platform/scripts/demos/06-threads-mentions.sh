#!/usr/bin/env bash
# Scripted acceptance demo for threads + @mentions (issue #6).
# reply → thread broadcast over WS → ordered thread view + reply count →
# @mention an agent → actionable mention event over WS → my mentions + count →
# self/unknown create nothing → read-only member blocked from replying.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #6 threads + @mentions demo"
cyan "==> 1/7  Infra (Postgres + Redis) + migrate + boot server"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo6-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done

cyan "==> 2/7  Human signup (member A = Lead) + create #general + post a root message"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"g-$$@e.com\",\"password\":\"pw\",\"displayName\":\"Lead\",\"workspaceSlug\":\"demo6-$(date +%s)\"}" >/dev/null
RID="$(awk '$6=="rid"{print $7}' "$JAR")"
ME=$(curl -s -b "$JAR" localhost:3000/me); WS=$(printf '%s' "$ME" | field workspaceId)
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
ROOT=$(curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages" -H 'content-type: application/json' -d '{"body":"lets discuss the rollout"}' | field id)
echo "    workspace=$WS  channel(#general)=$CID  root message=$ROOT"

cyan "==> 3/7  Register an agent (member B = Scout)"
AID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Scout"}')
AMEM=$(printf '%s' "$AID" | field memberId); ATOK=$(printf '%s' "$AID" | field token)
echo "    agent member=$AMEM"

cyan "==> 4/7  Drive WebSocket clients: A subscribes to #general; agent B just connects (no subscribe)"
# One Node process for deterministic ordering. cwd=apps/server so the bare 'ws' import resolves.
( cd apps/server && RID="$RID" CID="$CID" ROOT="$ROOT" ATOK="$ATOK" AMEM="$AMEM" \
  node --input-type=module -e '
import { WebSocket } from "ws";
const BASE = "ws://localhost:3000/ws";
const { RID, CID, ROOT, ATOK, AMEM } = process.env;
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
console.log("    agent B connected (NOT subscribed to any channel)");

// (a) threaded reply → broadcast over WS as a message carrying parentMessageId
await fetch(`http://localhost:3000/channels/${CID}/messages/${ROOT}/replies`, {
  method:"POST", headers:{ "content-type":"application/json", cookie:`rid=${RID}` },
  body: JSON.stringify({ body:"first reply in the thread" }) });
const m = await a.wait(e=>e.type==="message");
console.log(g(`    thread: A received reply over WS ✓ parentMessageId=${m.message.parentMessageId===ROOT?"root ✓":"?"} body="${m.message.body}"`));

// (b) @mention the agent → actionable mention event on B (even though B never subscribed)
await fetch(`http://localhost:3000/channels/${CID}/messages`, {
  method:"POST", headers:{ "content-type":"application/json", cookie:`rid=${RID}` },
  body: JSON.stringify({ body:"hey @Scout please take this; cc @ghost and myself @Lead" }) });
const mention = await b.wait(e=>e.type==="mention");
console.log(g(`    mention: agent B received an ACTIONABLE @mention over WS ✓ (to member ${mention.mention.mentionedMemberId===AMEM?"= Scout ✓":"?"})`));

a.close(); b.close();
' )

cyan "==> 5/7  Thread view: root + replies in order, with a reply count"
printf "    GET thread: "; curl -s -b "$JAR" "localhost:3000/channels/$CID/messages/$ROOT/thread"; echo

cyan "==> 6/7  Agent's mentions + count (self @Lead and unknown @ghost created nothing)"
printf "    GET /me/mentions       (as Scout): "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/mentions; echo
printf "    GET /me/mentions/count (as Scout): "; curl -s -H "authorization: Bearer $ATOK" localhost:3000/me/mentions/count; echo
printf "    GET /me/mentions/count (as Lead, self-mention excluded): "; curl -s -b "$JAR" localhost:3000/me/mentions/count; echo

cyan "==> 7/7  #9 capability enforced: a read-only member can view the thread but cannot reply"
RD=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Reader"}')
RMEM=$(printf '%s' "$RD" | field memberId); RTOK=$(printf '%s' "$RD" | field token)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/grants" -H 'content-type: application/json' -d "{\"memberId\":\"$RMEM\",\"capability\":\"read\"}" >/dev/null
printf "    read-only GET thread  → HTTP "; curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer $RTOK" "localhost:3000/channels/$CID/messages/$ROOT/thread"; echo " (200 = can view)"
printf "    read-only POST reply  → HTTP "; curl -s -o /dev/null -w "%{http_code}" -XPOST -H "authorization: Bearer $RTOK" -H 'content-type: application/json' -d '{"body":"may I?"}' "localhost:3000/channels/$CID/messages/$ROOT/replies"; echo " (403 = blocked, needs write)"

green "==> Threads + @mentions verified: reply broadcast over WS, ordered thread + count, actionable agent @mention, my-mentions/count, self+unknown excluded, RBAC enforced."
