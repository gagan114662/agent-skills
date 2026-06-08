import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * #10 — MCP integration, end to end. An off-the-shelf MCP client (the official SDK `Client` over
 * Streamable HTTP) holding ONLY an agent Bearer token connects and participates: list tools, post a
 * message (visible live via the #5 bus / web UI), is denied a write it lacks (#9), and is pushed an
 * @mention via a resource subscription (#6). Plus cross-workspace rejection (#3 IDOR). Real Postgres
 * + Redis (the subscription bridge rides the #5 bus), so this test listens on a real port.
 */

let app: FastifyInstance;
let mcpUrl: URL;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newOwner(): Promise<Owner> {
  const slug = `mcp-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function newAgent(owner: Owner, name: string): Promise<{ memberId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json();
  return { memberId: reg.memberId, token: reg.token };
}

async function createChannel(owner: Owner, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/channels`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  return res.json().id as string;
}

async function grant(
  owner: Owner,
  channelId: string,
  memberId: string,
  capability: "read" | "write" | "propagate",
): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/channels/${channelId}/grants`,
    cookies: { rid: owner.cookie },
    payload: { memberId, capability },
  });
}

/** Connect a fresh MCP client over Streamable HTTP, authenticated by the agent Bearer token. */
async function connectMcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "mcp-it", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Parse a tool result's JSON text payload. */
function payload(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find((c) => c.type === "text")?.text ?? "null";
  return JSON.parse(text);
}

describe("#10 MCP integration (real Postgres + Redis)", () => {
  it("an MCP client with only a Bearer token: tools → post (live) → RBAC-denied → @mention push", async () => {
    const owner = await newOwner();
    const handle = `scout${newId().replace(/-/g, "")}`;
    const agent = await newAgent(owner, handle);
    const general = await createChannel(owner, "general");
    const readOnly = await createChannel(owner, "read-only");
    const priv = await createChannel(owner, "private");
    await grant(owner, general, agent.memberId, "write");
    await grant(owner, readOnly, agent.memberId, "read");
    // `priv` left ungranted → must be invisible to the agent.

    const client = await connectMcp(agent.token);

    // 1. the join-and-act tool catalog is advertised.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_channels", "post_message", "read_messages", "search"]),
    );

    // 2. list_channels is capability-filtered (write/read annotated, private absent).
    const channels = payload(
      await client.callTool({ name: "list_channels", arguments: {} }),
    ) as Array<{ id: string; capability: string }>;
    const byId = new Map(channels.map((c) => [c.id, c.capability]));
    expect(byId.get(general)).toBe("write");
    expect(byId.get(readOnly)).toBe("read");
    expect(byId.has(priv)).toBe(false);

    // 3. post_message into a channel it has write on → ok, and visible via the REST/web read (#5).
    const posted = await client.callTool({
      name: "post_message",
      arguments: { channelId: general, body: "scout online via MCP" },
    });
    expect(posted.isError).toBeFalsy();
    const restMessages = (
      await app.inject({
        method: "GET",
        url: `/channels/${general}/messages`,
        headers: { authorization: `Bearer ${agent.token}` },
      })
    ).json() as Array<{ body: string }>;
    expect(restMessages.map((m) => m.body)).toContain("scout online via MCP");

    // 4. RBAC respected: posting into a read-only channel is a tool error (#9), not an escalation.
    const denied = await client.callTool({
      name: "post_message",
      arguments: { channelId: readOnly, body: "should be blocked" },
    });
    expect(denied.isError).toBe(true);

    // 5. @mention surfaces to the MCP client via a resource subscription.
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri: "reload://mentions" });

    await app.inject({
      method: "POST",
      url: `/channels/${general}/messages`,
      cookies: { rid: owner.cookie },
      payload: { body: `@${handle} please triage the queue` },
    });

    await waitFor(() => updates.includes("reload://mentions"), 8000);
    const mentions = JSON.parse(
      (await client.readResource({ uri: "reload://mentions" })).contents[0]!.text as string,
    ) as Array<{ body: string }>;
    expect(mentions.map((m) => m.body)).toContain(`@${handle} please triage the queue`);

    await client.close();
  });

  it("rejects cross-workspace access through MCP tools (#3 IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const generalA = await createChannel(a, "secrets");
    const agentB = await newAgent(b, `intruder${newId().replace(/-/g, "")}`);

    const client = await connectMcp(agentB.token);

    // B's token cannot read or post into A's channel — a tool error, never A's data.
    const read = await client.callTool({
      name: "read_messages",
      arguments: { channelId: generalA },
    });
    expect(read.isError).toBe(true);
    const post = await client.callTool({
      name: "post_message",
      arguments: { channelId: generalA, body: "leak attempt" },
    });
    expect(post.isError).toBe(true);

    // B's accessible-channel list never contains A's channel.
    const channels = payload(
      await client.callTool({ name: "list_channels", arguments: {} }),
    ) as Array<{ id: string }>;
    expect(channels.some((c) => c.id === generalA)).toBe(false);

    await client.close();
  });

  it("rejects an MCP connection with no Bearer token", async () => {
    const client = new Client({ name: "noauth", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    await expect(client.connect(transport)).rejects.toThrow();
  });
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
