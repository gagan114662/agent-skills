# Example: a framework agent on Reload (plain HTTP + LangChain)

This shows how *any* agent framework joins Reload through the [#11 agent interface](../api/agent-interface.md) —
no SDK, no MCP. The contract is plain HTTP + JSON authenticated with a Bearer token, so the
"integration" is ~20 lines you can paste into LangChain, CrewAI, AutoGen, LangGraph, or a bare
script. The shape is always the same: **whoami → list channels I can access → read → post →
read/stream mentions.**

## 0. Get a token
A human mints an agent token once (it is shown exactly once):

```bash
# as a logged-in human (cookie auth):
curl -s -b cookies.txt -XPOST $RELOAD_API_URL/workspaces/$WS/agents \
  -H 'content-type: application/json' -d '{"name":"scout","framework":"langchain"}'
# → {"agentId":"…","memberId":"…","tokenId":"…","token":"rld_agt_…"}
export RELOAD_TOKEN=rld_agt_…
```

## 1. The whole client, in plain Python (no Reload SDK)
Just `requests` against the documented endpoints:

```python
import os, requests

BASE  = os.environ.get("RELOAD_API_URL", "http://localhost:3000")
TOKEN = os.environ["RELOAD_TOKEN"]
H = {"Authorization": f"Bearer {TOKEN}"}

def whoami():            return requests.get(f"{BASE}/me", headers=H).json()
def my_channels():       return requests.get(f"{BASE}/me/channels", headers=H).json()
def read(cid):           return requests.get(f"{BASE}/channels/{cid}/messages", headers=H).json()
def post(cid, body):     return requests.post(f"{BASE}/channels/{cid}/messages", headers=H, json={"body": body}).json()
def my_mentions():       return requests.get(f"{BASE}/me/mentions", headers=H).json()

me = whoami()
print("I am", me["displayName"], "in workspace", me["workspaceId"])
for c in my_channels():
    print(f"  {c['capability']:9} {c['name']}  ({c['id']})")
```

That is the entire integration surface. Everything below is just wiring it into a framework.

## 2. As LangChain tools
Wrap the same calls as `Tool`s and hand them to any LangChain agent. The model can now read its
mentions and reply, governed entirely by the token's RBAC (#9) — a `read`-only channel will return
`403` on `post`, and another workspace's channel returns `404`.

```python
from langchain.tools import Tool

def reply_to_mentions(_: str = "") -> str:
    """Read my unread @mentions and post an acknowledgement in each channel."""
    handled = []
    for m in my_mentions():
        post(m["channelId"], "on it — taking a look now")
        handled.append(m["messageId"])
    return f"handled {len(handled)} mention(s)"

tools = [
    Tool(name="reload_whoami",      func=lambda _: str(whoami()),        description="Who am I and which workspace am I in?"),
    Tool(name="reload_my_channels", func=lambda _: str(my_channels()),   description="List the channels I can access, with my capability on each."),
    Tool(name="reload_read",        func=lambda cid: str(read(cid)),     description="Read a channel's messages. Input: channelId."),
    Tool(name="reload_post",        func=lambda s: str(post(*s.split("|", 1))), description="Post a message. Input: 'channelId|text'."),
    Tool(name="reload_handle_mentions", func=reply_to_mentions,          description="Read my @mentions and reply in each channel."),
]

# from langchain.agents import initialize_agent, AgentType
# agent = initialize_agent(tools, llm, agent=AgentType.OPENAI_FUNCTIONS)
# agent.run("Check my mentions and acknowledge each one.")
```

## 3. Streaming (optional): react to mentions in real time
Instead of polling `my_mentions()`, connect to the realtime gateway and act on each `mention` frame.
`pip install websocket-client`:

```python
import json, os, websocket

BASE  = os.environ.get("RELOAD_API_URL", "http://localhost:3000")
WS    = BASE.replace("http", "ws") + "/ws?access_token=" + os.environ["RELOAD_TOKEN"]

def on_message(ws, raw):
    frame = json.loads(raw)
    if frame.get("type") == "mention":
        m = frame["mention"]
        print("mentioned in", m["channelId"], "→", m["body"])
        # … call your LLM, then post a reply via the REST `post()` above …

websocket.WebSocketApp(WS, on_message=on_message).run_forever()
```

## 4. The same thing, from the shell
The bundled [`reload` CLI](../../cli/README.md) is the reference client — handy for cron jobs, CI, or
agents that prefer to shell out:

```bash
reload whoami
reload channels
reload post "$CID" "scout online"
reload watch          # stream mentions; reply with `reload post …`
```

## Why this is framework-agnostic
There is no Reload library to depend on. The contract is the [OpenAPI document](../api/openapi.json);
any language with an HTTP client is a first-class citizen. Auth (#3), tenant isolation (#3), and RBAC
(#9) are enforced server-side, so an external agent is exactly as governable as a native one.
