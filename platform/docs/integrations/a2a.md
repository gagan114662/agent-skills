# A2A (Agent2Agent) integration

Reload speaks **A2A** so an agent that already talks A2A can discover a Reload agent and hand it a
task — **with no custom glue**. The adapter is a thin translation over Reload's existing model
(identity #3, tasks #14, RBAC #9): it grants no authority your token didn't already have, and every
call is workspace-scoped. See [ADR-0012](../adrs/0012-acp-a2a.md) and the
[spec](../specs/12-acp-a2a.md).

- **Transport:** JSON-RPC 2.0 over HTTP (A2A's default). `streaming` and `pushNotifications` are
  **not** supported yet (the AgentCard says so).
- **Auth:** an agent Bearer token (`rld_agt_…`, #3) on every call: `Authorization: Bearer <token>`.
- **Spec version:** A2A `0.3.x`. Emitted objects validate against the vendored schema at
  `apps/server/test/fixtures/a2a.schema.json`.

## 1. Capability handshake — fetch the AgentCard

```
GET /a2a/agents/:agentId/agent-card.json      (auth required; workspace-scoped)
```

`:agentId` is the registry agent id (from `POST /workspaces/:wid/agents`, #3). The card tells a
caller how to authenticate and what the agent accepts:

```bash
curl -s http://localhost:3000/a2a/agents/$AGENT_ID/agent-card.json \
  -H "Authorization: Bearer $RELOAD_TOKEN"
```
```jsonc
{
  "protocolVersion": "0.3.0",
  "name": "planner",
  "url": "http://localhost:3000/a2a/agents/<agentId>",   // the JSON-RPC endpoint
  "preferredTransport": "JSONRPC",
  "version": "1.0.0",
  "capabilities": { "streaming": false, "pushNotifications": false, "stateTransitionHistory": true },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    { "id": "handoff", "name": "Task handoff", "tags": ["handoff", "task", "langgraph"], "description": "…" },
    { "id": "messaging", "name": "Workspace messaging", "tags": ["messaging", "langgraph"], "description": "…" }
  ],
  "securitySchemes": { "bearerAuth": { "type": "http", "scheme": "bearer" } },
  "security": [{ "bearerAuth": [] }]
}
```

A card for an agent in another workspace returns **404** — discovery never crosses tenants.

## 2. Handoff — `message/send`

`POST /a2a/agents/:agentId` is the JSON-RPC endpoint. The authenticated identity is the **sending**
agent; `:agentId` is the **receiving** agent. A handoff creates a Reload task assigned to the
receiver, preserving the message content as the task's context.

```bash
curl -s http://localhost:3000/a2a/agents/$RECEIVER_AGENT_ID \
  -H "Authorization: Bearer $SENDER_TOKEN" -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "message/send",
    "params": { "message": {
      "kind": "message", "role": "user", "messageId": "m1",
      "parts": [{ "kind": "text", "text": "investigate the outage and report findings" }]
    }}
  }'
```
```jsonc
{ "jsonrpc": "2.0", "id": 1, "result": {
    "kind": "task",
    "id": "<taskId>",
    "contextId": "<taskId>",
    "status": { "state": "submitted" },
    "artifacts": [],
    "history": [{ "kind": "message", "role": "user", "messageId": "m1",
                  "parts": [{ "kind": "text", "text": "investigate the outage and report findings" }],
                  "taskId": "<taskId>", "contextId": "<taskId>" }]
}}
```

## 3. Track / cancel — `tasks/get`, `tasks/cancel`

The receiving agent (or anyone in the workspace) reads the handed-off task — **the original content
is intact** in `history`:

```bash
curl -s http://localhost:3000/a2a/agents/$RECEIVER_AGENT_ID \
  -H "Authorization: Bearer $RECEIVER_TOKEN" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"<taskId>"}}'

curl -s http://localhost:3000/a2a/agents/$RECEIVER_AGENT_ID \
  -H "Authorization: Bearer $RECEIVER_TOKEN" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tasks/cancel","params":{"id":"<taskId>"}}'
```

The same task is visible through the native task routes (#14) — e.g. `GET /tasks/<taskId>` shows
`assigneeMemberId` = the receiver and the `a2a` label. The two surfaces are the same data.

## State mapping (Reload task status → A2A `TaskState`)

| Reload status | A2A state |
|---|---|
| `backlog`, `todo` | `submitted` |
| `in_progress` | `working` |
| `blocked` | `input-required` |
| `done` | `completed` |
| `canceled` | `canceled` |

## Errors (JSON-RPC)
- `-32600` invalid request · `-32601` unknown method · `-32602` invalid params / agent not found ·
  `-32001` task not found (incl. cross-workspace) · HTTP `401` if the Bearer token is missing/invalid.

## Not supported yet (see ADR-0012 follow-ups)
`message/stream` (SSE), push notifications, `tasks/resubscribe`, gRPC/HTTP+JSON transports, and
binary file/data parts (non-text parts are normalized to text in the handoff context).
