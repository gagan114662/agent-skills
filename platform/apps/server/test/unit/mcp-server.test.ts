import { describe, it, expect, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReloadMcpServer, MENTIONS_URI } from "../../src/mcp/server.js";
import type { RealtimeSubscriptions } from "../../src/mcp/realtime-subscriptions.js";
import type { OutboundEmailSubmitter } from "../../src/email/agent-outbound.js";
import type { Identity } from "../../src/auth/identity.js";

/**
 * Unit coverage for the #10 MCP server *shape* — hermetic (no Postgres, no Redis). It connects an
 * SDK client to `createReloadMcpServer` over an in-memory transport and asserts the advertised
 * tool/resource catalog and that an injected mention drives a `notifications/resources/updated`.
 * The behavioural (DB/RBAC/live-bus) coverage lives in `test/integration/mcp.test.ts`.
 */

const identity: Identity = {
  workspaceId: "ws_test",
  memberId: "mem_test",
  kind: "agent",
  displayName: "scout",
};

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  fatal() {},
  trace() {},
  child() {
    return silentLogger;
  },
  level: "silent",
} as unknown as FastifyBaseLogger;

/** A fake realtime source whose mention callback we fire by hand — no Redis. */
function fakeRealtime(): { realtime: RealtimeSubscriptions; fireMention: () => void } {
  let cb: (() => void) | null = null;
  return {
    realtime: {
      subscribeMentions(_w, _m, onMention) {
        cb = () => onMention({} as never);
        return () => {
          cb = null;
        };
      },
      subscribeChannel() {
        return () => {};
      },
    },
    fireMention: () => cb?.(),
  };
}

async function connectPair(
  realtime: RealtimeSubscriptions,
  outboundEmail?: OutboundEmailSubmitter,
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createReloadMcpServer(identity, { logger: silentLogger, realtime, outboundEmail });
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const TOOL_NAMES = [
  "list_channels",
  "read_messages",
  "post_message",
  "reply_thread",
  "search",
  "list_tasks",
  "update_task",
  "read_memory",
  "write_memory",
  "send_outbound_email",
];

describe("#10 MCP server (hermetic, in-memory transport)", () => {
  it("advertises the join-and-act tool catalog with input schemas", async () => {
    const client = await connectPair(fakeRealtime().realtime);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    // every tool publishes an input schema (an object schema, even if empty)
    for (const t of tools) expect(t.inputSchema?.type).toBe("object");
    await client.close();
  });

  it("advertises the mentions resource and the channel-messages template (subscribable)", async () => {
    const client = await connectPair(fakeRealtime().realtime);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(MENTIONS_URI);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain(
      "reload://channels/{channelId}/messages",
    );
    // the server negotiated the `resources.subscribe` capability
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
    await client.close();
  });

  it("pushes resources/updated for reload://mentions when a mention arrives on the bus", async () => {
    const { realtime, fireMention } = fakeRealtime();
    const client = await connectPair(realtime);
    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updated.push(n.params.uri);
    });
    await client.subscribeResource({ uri: MENTIONS_URI });

    fireMention(); // simulate an @mention landing on the realtime stream

    await vi_waitFor(() => updated.includes(MENTIONS_URI));
    expect(updated).toContain(MENTIONS_URI);
    await client.close();
  });

  it("rejects subscribing to an unknown resource uri", async () => {
    const client = await connectPair(fakeRealtime().realtime);
    await expect(client.subscribeResource({ uri: "reload://nope" })).rejects.toThrow();
    await client.close();
  });

  it("#463 send_outbound_email queues for owner approval (never sends in-tool)", async () => {
    const submit: OutboundEmailSubmitter = vi.fn().mockResolvedValue({
      ok: true,
      status: "pending",
      requestId: "req_42",
      summary: "Email to prospect@example.com: Quick intro",
    });
    const client = await connectPair(fakeRealtime().realtime, submit);

    const res = await client.callTool({
      name: "send_outbound_email",
      arguments: { to: "prospect@example.com", subject: "Quick intro", body: "Hello" },
    });

    expect(res.isError).toBeFalsy();
    expect(submit).toHaveBeenCalledWith({
      to: "prospect@example.com",
      subject: "Quick intro",
      body: "Hello",
    });
    const payload = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(payload.status).toBe("pending_approval");
    expect(payload.requestId).toBe("req_42");
    expect(String(payload.message).toLowerCase()).toContain("approve");
    await client.close();
  });

  it("#463 send_outbound_email surfaces a validation failure as a tool error", async () => {
    const submit: OutboundEmailSubmitter = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "a valid recipient email address is required" });
    const client = await connectPair(fakeRealtime().realtime, submit);

    const res = await client.callTool({
      name: "send_outbound_email",
      arguments: { to: "nope", subject: "Hi", body: "Body" },
    });

    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toContain("valid recipient");
    await client.close();
  });
});

/** Poll until `pred()` is true or a short timeout elapses (notifications are async over the pair). */
async function vi_waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
