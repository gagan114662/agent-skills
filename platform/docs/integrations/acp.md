# ACP (Agent Communication Protocol) integration

Reload speaks **ACP** so an agent that already talks ACP can list Reload's agents and drive *runs*
against them — **with no custom glue**. An ACP run maps directly onto a Reload conversation: the
run's messages become channel messages in a thread (#4/#6), so an ACP client and a human in Slack
see the same conversation. The adapter grants no new authority and is workspace-scoped. See
[ADR-0012](../adrs/0012-acp-a2a.md) and the [spec](../specs/12-acp-a2a.md).

- **Transport:** plain REST + JSON.
- **Auth:** an agent Bearer token (`rld_agt_…`, #3) — or any workspace identity — on every call:
  `Authorization: Bearer <token>`.
- **Spec version:** ACP `2025-draft`. Emitted objects validate against the vendored schema at
  `apps/server/test/fixtures/acp.schema.json`.

## The model: a run **is** a thread

| ACP concept | Reload realization |
|---|---|
| `run_id` / `session_id` | the **thread-root** message id |
| run input messages | channel messages (first = root @mentioning the agent; rest = replies) |
| run `output` | the target agent's **in-thread replies** |
| `agent_name` | the first agent-kind member @mentioned on the root |
| run `status` | `created` (no agent reply) → `completed` (agent replied) → `cancelled` |

Reload does not *execute* the agent for you here (that is the cloud-execution runtime, #25); an ACP
client posts a run and polls `GET /acp/runs/:run_id`.

## 1. Discovery — list agent manifests

```bash
curl -s http://localhost:3000/acp/agents      -H "Authorization: Bearer $RELOAD_TOKEN"
curl -s http://localhost:3000/acp/agents/planner -H "Authorization: Bearer $RELOAD_TOKEN"
```
```jsonc
{ "name": "planner", "description": "Reload agent \"planner\" — reachable over ACP runs.",
  "metadata": { "kind": "agent", "framework": "crewai", "status": "active", "provider": "reload" } }
```

## 2. Create a run — post messages into a channel thread

`channel_id` is required for a new run (the caller must have `write` on it, #9). `agent_name` is the
target agent's handle (its @mention name).

```bash
curl -s http://localhost:3000/acp/runs \
  -H "Authorization: Bearer $RELOAD_TOKEN" -H "content-type: application/json" \
  -d '{
    "agent_name": "planner",
    "input": [{ "role": "user", "parts": [{ "content_type": "text/plain", "content": "plan the launch" }] }],
    "metadata": { "channel_id": "'"$CHANNEL_ID"'" }
  }'
```
```jsonc
{ "run_id": "<rootMessageId>", "agent_name": "planner", "session_id": "<rootMessageId>",
  "status": "created", "output": [] }
```

The input now lives in the channel as a thread root: `GET /channels/$CHANNEL_ID/messages` shows a
message `@planner plan the launch`. When the agent replies in that thread (e.g. via the native
`POST /channels/:cid/messages/:mid/replies`, #6), the run's output picks it up.

## 3. Read a run — `GET /acp/runs/:run_id`

```bash
curl -s http://localhost:3000/acp/runs/$RUN_ID -H "Authorization: Bearer $RELOAD_TOKEN"
```
```jsonc
{ "run_id": "<rootMessageId>", "agent_name": "planner", "session_id": "<rootMessageId>",
  "status": "completed",
  "output": [{ "role": "agent", "parts": [{ "content_type": "text/plain", "content": "here is the plan" }] }] }
```

## 4. Continue a run (session) / cancel

Pass `session_id` (= the `run_id`) instead of `metadata.channel_id` to add more input to the **same**
thread; omit `channel_id`. Cancel is best-effort and non-destructive (a thread is durable
conversation — cancel just reports `status: "cancelled"`):

```bash
curl -s http://localhost:3000/acp/runs \
  -H "Authorization: Bearer $RELOAD_TOKEN" -H "content-type: application/json" \
  -d '{"agent_name":"planner","session_id":"'"$RUN_ID"'","input":[{"role":"user","parts":[{"content_type":"text/plain","content":"and the budget?"}]}]}'

curl -s -X POST http://localhost:3000/acp/runs/$RUN_ID/cancel -H "Authorization: Bearer $RELOAD_TOKEN"
```

## Workspace scoping (#3 IDOR)
A `run_id` (thread root) or `channel_id` from another workspace returns **404** — existence never
leaks. Posting a run requires `write` on the target channel (#9); reading requires `read`.

## Not supported yet (see ADR-0012 follow-ups)
Synchronous/streaming run **execution** (`mode: "sync"|"stream"`), `awaiting` (input-required)
runs, and the full ACP run-status set — these arrive when runs are backed by the cloud-execution
runtime (#25). Today an ACP run posts the conversation and the client polls.
