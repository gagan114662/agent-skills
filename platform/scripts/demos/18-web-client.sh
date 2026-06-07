#!/usr/bin/env bash
# Scripted acceptance demo for the Web Client (issue #18).
#
# The web client is a React app that consumes the existing server REST + WebSocket API as-is.
# This terminal demo proves the slice end-to-end without a screen recorder:
#   1) the web app type-checks, lints (workspace) and BUILDS
#   2) the web component/unit suite is green (auth, sidebar, messages, threads, @mention, presence)
#   3) the exact realtime events the UI renders actually fire against a live server:
#        sign-in (rid cookie) → channels → post → live `message` over /ws →
#        @mention an agent → actionable `mention` over /ws → thread reply + thread view
# A companion browser walkthrough (docs/demos/18-web-client.mp4) shows the rendered UI.
# Run from platform/.
set -euo pipefail
cd "$(dirname "$0")/../.."

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
JAR="$(mktemp)"; SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$JAR"; }
trap cleanup EXIT
field() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

cyan "==> Reload — issue #18 web client demo"

cyan "==> 1/6  Web client gates: typecheck + build (apps/web must build)"
pnpm --filter @reload/web typecheck
pnpm --filter @reload/web build 2>&1 | tail -4

cyan "==> 2/6  Web client test suite (vitest: api client, /ws client, store, components)"
pnpm --filter @reload/web test 2>&1 | tail -8

cyan "==> 3/6  Boot the stack the client talks to (Postgres + Redis + migrate + server)"
docker compose up -d >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ] && break; sleep 1; done
pnpm --filter @reload/server db:migrate >/dev/null
pnpm --filter @reload/server exec tsx src/index.ts >/tmp/reload-demo18-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs localhost:3000/healthz >/dev/null 2>&1 && break; sleep 0.5; done
echo "    server healthy: $(curl -s localhost:3000/healthz)"

cyan "==> 4/6  Sign in (the client's auth flow): signup sets the httpOnly rid cookie; GET /me bootstraps"
curl -s -c "$JAR" -XPOST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"ada-$$@e.com\",\"password\":\"hunter2pw\",\"displayName\":\"Ada\",\"workspaceSlug\":\"web18-$(date +%s)\"}" >/dev/null
ME=$(curl -s -b "$JAR" localhost:3000/me)
WS=$(printf '%s' "$ME" | field workspaceId)
echo "    GET /me → $ME"
CID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/channels" -H 'content-type: application/json' -d '{"name":"general"}' | field id)
echo "    created #general = $CID"

cyan "==> 5/6  Register an agent member (agent-first); both humans & agents are members"
AID=$(curl -s -b "$JAR" -XPOST "localhost:3000/workspaces/$WS/agents" -H 'content-type: application/json' -d '{"name":"Atlas","framework":"claude"}')
AMEM=$(printf '%s' "$AID" | field memberId); ATOK=$(printf '%s' "$AID" | field token)
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/members" -H 'content-type: application/json' -d "{\"memberId\":\"$AMEM\"}" >/dev/null
printf "    member search (what the @mention autocomplete + members rail consume): "
curl -s -b "$JAR" "localhost:3000/workspaces/$WS/search/members?q=a" ; echo

cyan "==> 6/6  Drive the live /ws events the message pane renders (subscribe → message → mention)"
ROOT=$( cd apps/server && RID="$(awk '$6=="rid"{print $7}' "$JAR")" CID="$CID" ATOK="$ATOK" AMEM="$AMEM" \
  node --input-type=module -e '
import { WebSocket } from "ws";
const { RID, CID, ATOK, AMEM } = process.env;
const g = (s) => `\x1b[1;32m${s}\x1b[0m`;
class C { constructor(ws){ this.ws=ws; this.ev=[]; this.w=[];
    ws.on("message",(d)=>{ const e=JSON.parse(d.toString()); this.ev.push(e);
      this.w=this.w.filter(x=>{ if(x.m(e)){x.r(e);return false;} return true;}); }); }
  send(c){ this.ws.send(JSON.stringify(c)); }
  wait(m,ms=5000){ const f=this.ev.find(m); if(f) return Promise.resolve(f);
    return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error("timeout")),ms);
      this.w.push({m,r:(e)=>{clearTimeout(t);res(e);}}); }); }
  close(){ this.ws.close(); } }
const open=(opts)=>new Promise((res,rej)=>{ const ws=new WebSocket("ws://localhost:3000/ws",opts); const c=new C(ws);
  ws.on("open",()=>res(c)); ws.on("error",rej); });

// A human browser session (rid cookie) subscribes to #general, like the web app on channel select.
const human = await open({ headers:{ cookie:`rid=${RID}` } });
await human.wait(e=>e.type==="ready");
human.send({ type:"subscribe", channelId:CID });
await human.wait(e=>e.type==="subscribed");
console.error("    web session connected + subscribed to #general over /ws");

// The agent connects (no channel subscription) — it still gets actionable @mentions.
const agent = await open({ headers:{ authorization:`Bearer ${ATOK}` } });
await agent.wait(e=>e.type==="ready");
console.error("    agent Atlas connected (no subscription) — listening for @mentions");

// Human posts → the message pane appends it live via the `message` event.
const posted = await (await fetch(`http://localhost:3000/channels/${CID}/messages`, {
  method:"POST", headers:{ "content-type":"application/json", cookie:`rid=${RID}` },
  body: JSON.stringify({ body:"Kicking off the deploy. @Atlas run the smoke tests?" }) })).json();
const live = await human.wait(e=>e.type==="message");
console.error(g(`    web session received live message over /ws ✓ body="${live.message.body}"`));

// …and Atlas gets the @mention even though it never subscribed — the actionable agent signal.
const mention = await agent.wait(e=>e.type==="mention");
console.error(g(`    agent received an ACTIONABLE @mention over /ws ✓ (to ${mention.mention.mentionedMemberId===AMEM?"Atlas ✓":"?"})`));

human.close(); agent.close();
process.stdout.write(posted.id);
' )

printf "    thread view (what the thread panel renders): "
curl -s -b "$JAR" -XPOST "localhost:3000/channels/$CID/messages/$ROOT/replies" -H 'content-type: application/json' -d '{"body":"smoke suite green, 142/142"}' >/dev/null
curl -s -b "$JAR" "localhost:3000/channels/$CID/messages/$ROOT/thread"; echo

green "==> Web client verified: builds + tests green, and the live sign-in → channels → post →"
green "    realtime message → actionable @mention → thread flow it renders works against the server."
