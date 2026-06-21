import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * #515 — agents manage tasks autonomously over MCP: create a task, hand it to another agent, and
 * record blockers (cycles rejected). Real Postgres + Redis, real MCP client over Streamable HTTP,
 * holding only an agent Bearer token. These are internal, reversible actions — no approval gate.
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
  const slug = `mcptask-${newId()}`;
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

async function connectMcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "mcp-tasks-it", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function payload(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find((c) => c.type === "text")?.text ?? "null";
  return JSON.parse(text);
}

describe("#515 MCP task management (real Postgres + Redis)", () => {
  it("an agent creates a task, hands it off, and records a blocker — all over MCP", async () => {
    const owner = await newOwner();
    const scout = await newAgent(owner, `scout${newId().replace(/-/g, "")}`);
    const quill = await newAgent(owner, `quill${newId().replace(/-/g, "")}`);
    const client = await connectMcp(scout.token);

    // the task-coordination tools are advertised
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["create_task", "handoff_task", "add_task_dependency", "list_tasks", "update_task"]),
    );

    // 1. create a task assigned to itself
    const created = payload(
      await client.callTool({
        name: "create_task",
        arguments: { title: "Ship the launch", labels: ["build"], assigneeMemberId: scout.memberId },
      }),
    ) as { id: string; assigneeMemberId: string; status: string };
    expect(created.assigneeMemberId).toBe(scout.memberId);
    expect(created.status).toBe("backlog");

    // it shows up in list_tasks
    const listed = payload(await client.callTool({ name: "list_tasks", arguments: {} })) as Array<{ id: string }>;
    expect(listed.some((t) => t.id === created.id)).toBe(true);

    // 2. hand it off to quill with a note — reassignment IS the handoff
    const handed = payload(
      await client.callTool({
        name: "handoff_task",
        arguments: { taskId: created.id, toMemberId: quill.memberId, note: "your turn — brief in #content" },
      }),
    ) as { assigneeMemberId: string };
    expect(handed.assigneeMemberId).toBe(quill.memberId);

    // the handoff is a real audited event on the task
    const events = (await app.inject({ method: "GET", url: `/tasks/${created.id}/events`, cookies: { rid: owner.cookie } })).json();
    expect(events.some((e: { type: string; toValue: string }) => e.type === "handoff" && e.toValue === quill.memberId)).toBe(true);

    // 3. record a blocker: a second task that 'Ship the launch' depends on
    const blocker = payload(
      await client.callTool({ name: "create_task", arguments: { title: "Cut the release branch" } }),
    ) as { id: string };
    const dep = payload(
      await client.callTool({
        name: "add_task_dependency",
        arguments: { taskId: created.id, blockedByTaskId: blocker.id },
      }),
    ) as { created: boolean; blockers: Array<{ id: string }> };
    expect(dep.created).toBe(true);
    expect(dep.blockers.map((b) => b.id)).toContain(blocker.id);

    // a cycle is rejected (blocker can't also depend on the task it blocks)
    const cycle = await client.callTool({
      name: "add_task_dependency",
      arguments: { taskId: blocker.id, blockedByTaskId: created.id },
    });
    expect(cycle.isError).toBe(true);

    await client.close();
  });

  it("rejects cross-workspace task creation targets and handoff targets (#3 IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const agentA = await newAgent(a, `a${newId().replace(/-/g, "")}`);
    const agentB = await newAgent(b, `b${newId().replace(/-/g, "")}`);
    const client = await connectMcp(agentA.token);

    // A's agent cannot create a task assigned to B's member
    const create = await client.callTool({
      name: "create_task",
      arguments: { title: "leak", assigneeMemberId: agentB.memberId },
    });
    expect(create.isError).toBe(true);

    // …and cannot hand its own task to B's member
    const mine = payload(
      await client.callTool({ name: "create_task", arguments: { title: "mine" } }),
    ) as { id: string };
    const handoff = await client.callTool({
      name: "handoff_task",
      arguments: { taskId: mine.id, toMemberId: agentB.memberId },
    });
    expect(handoff.isError).toBe(true);

    await client.close();
  });
});
