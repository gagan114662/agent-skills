import { describe, it, expect, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReloadMcpServer, MENTIONS_URI } from "../../src/mcp/server.js";
import type { RealtimeSubscriptions } from "../../src/mcp/realtime-subscriptions.js";
import type { OutboundEmailSubmitter } from "../../src/email/agent-outbound.js";
import type { Identity } from "../../src/auth/identity.js";
import type { BrowserSessionOpener } from "../../src/runtime/browser/agent-bridge.js";
import type { BrowserCaps } from "../../src/runtime/browser/caps.js";
import type { BrowserStepResult } from "../../src/runtime/browser/session.js";
import type { BrowserToolName } from "../../src/runtime/browser/tools.js";

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
  browser?: Parameters<typeof createReloadMcpServer>[1]["browser"],
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createReloadMcpServer(identity, { logger: silentLogger, realtime, outboundEmail, browser });
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
  "create_task",
  "handoff_task",
  "add_task_dependency",
  "read_memory",
  "write_memory",
  "list_traces",
  "get_trace",
  "send_outbound_email",
  "check_channel_connection",
  "send_through_channel",
];

const ENABLED_BROWSER_CAPS: BrowserCaps = {
  enabled: true,
  maxPages: 0,
  maxWallClockSeconds: 0,
  maxBandwidthBytes: 0,
  allowlist: [],
  denylist: [],
};

const DISABLED_BROWSER_CAPS: BrowserCaps = { ...ENABLED_BROWSER_CAPS, enabled: false };

function browserResult(tool: BrowserToolName, url: string | null = "https://example.com"): BrowserStepResult {
  return {
    ok: true,
    tool,
    decision: "allow",
    reason: "allowed",
    url,
    approvalRequestId: null,
    screenshotPath: "memory://shot.png",
  };
}

function fakeBrowserManager(): {
  manager: BrowserSessionOpener;
  open: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
} {
  const click = vi.fn().mockResolvedValue({
    ok: false,
    tool: "click",
    decision: "needs_approval",
    reason: "awaiting human approval (#13)",
    url: "https://example.com",
    approvalRequestId: "pending-1",
    screenshotPath: null,
  } satisfies BrowserStepResult);
  const session = {
    navigate: vi.fn().mockImplementation((url: string) => Promise.resolve(browserResult("navigate", url))),
    readPage: vi.fn().mockResolvedValue({
      ...browserResult("read_page"),
      page: { url: "https://example.com", title: "Example", text: "hello" },
    } satisfies BrowserStepResult),
    takeScreenshot: vi.fn().mockResolvedValue({ ...browserResult("screenshot"), screenshot: "base64" }),
    scroll: vi.fn().mockResolvedValue(browserResult("scroll")),
    wait: vi.fn().mockResolvedValue(browserResult("wait")),
    click,
    type: vi.fn().mockResolvedValue(browserResult("type")),
  };
  const open = vi.fn().mockResolvedValue(session);
  return { manager: { open }, open, click };
}

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

  it("keeps browser tools out of the MCP catalog when the #388 bridge is absent or disabled", async () => {
    const absent = await connectPair(fakeRealtime().realtime);
    expect((await absent.listTools()).tools.map((t) => t.name)).not.toContain("navigate");
    await absent.close();

    const { manager } = fakeBrowserManager();
    const disabled = await connectPair(fakeRealtime().realtime, undefined, {
      manager,
      caps: DISABLED_BROWSER_CAPS,
      sessionId: "browser-disabled",
    });
    expect((await disabled.listTools()).tools.map((t) => t.name)).not.toContain("navigate");
    await disabled.close();
  });

  it("registers the #388 browser bridge into live MCP and routes side effects through approval", async () => {
    const fake = fakeBrowserManager();
    const client = await connectPair(fakeRealtime().realtime, undefined, {
      manager: fake.manager,
      caps: ENABLED_BROWSER_CAPS,
      sessionId: "browser-live",
      target: "https://example.com",
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["navigate", "read_page", "screenshot", "scroll", "wait", "click", "type"]));

    const nav = await client.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
    expect(nav.isError).toBeFalsy();
    expect(fake.open).toHaveBeenCalledWith({
      workspaceId: identity.workspaceId,
      sessionId: "browser-live",
      target: "https://example.com",
    });

    const click = await client.callTool({ name: "click", arguments: { selector: "button[type=submit]" } });
    expect(click.isError).toBeFalsy();
    const payload = JSON.parse((click.content as { text: string }[])[0]!.text);
    expect(payload.decision).toBe("needs_approval");
    expect(payload.approvalRequestId).toBe("pending-1");
    expect(fake.click).toHaveBeenCalledWith("button[type=submit]");
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
