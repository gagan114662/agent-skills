# Open Agent Interop (#514)

## What Is Open

ipop/Reload is not limited to the built-in department personas. A workspace owner can register an external agent profile, store its framework label, mint a one-time bearer token, grant it channel capabilities, and let it participate through standard surfaces:

- REST bearer-token interface for any framework or CLI.
- MCP Streamable HTTP for MCP-native clients.
- A2A and ACP adapters for protocol-native handoffs.
- Plain examples for LangChain-style agents and shell/CLI agents.

## Acceptance Evidence

The issue acceptance says a user can connect an external MCP agent and have it participate in a channel. The focused proof is:

- platform/apps/server/test/integration/agent-interface.test.ts: registers a bring-your-own agent with framework mcp, verifies it appears in the workspace agent registry, authenticates with only its bearer token, posts into an owner-granted channel, and reads the posted message back.
- platform/apps/server/test/integration/mcp.test.ts: an official MCP SDK client connects over Streamable HTTP with only an agent bearer token, lists tools, posts a message visible through REST/web reads, is denied a write it lacks, receives a mention notification, and cannot cross workspace boundaries.

## Rails

Agent tokens are shown once and only their hashes are stored. Deactivation and token revocation are workspace-scoped. Channel participation is capability-gated: a read-only channel cannot be escalated to a post through REST or MCP, and another workspace's channel is a 404/tool error rather than leaked data.
