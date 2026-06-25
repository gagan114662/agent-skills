import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createChannel, listChannels } from "../../src/db/repositories/channels.js";
import { getAgentMemberByHandle } from "../../src/db/repositories/auth.js";
import { latestMessageId, listChannelMessages } from "../../src/db/repositories/messages.js";

/**
 * #361 (epic #359) — ACCEPTANCE: with the coordination layers enabled for the OWNER workspace
 * (A2A #282 → collaboration #319 → channel-posting #370), a briefed lead that delegates a subtask to a
 * teammate has the delegation **appear in the department channel** — a handoff status line authored by the
 * delegating agent plus an inline task card authored by the assignee. This is the substrate the
 * coordination view (#354) renders.
 *
 * Rails proven here (#200): the posting is gated DEFAULT-OFF + OWNER-WORKSPACE-FIRST + FAIL-CLOSED — with
 * the env unset, or named for a different workspace, the handoff still creates the task but NOTHING is
 * posted to the channel (prod channels stay byte-for-byte quiet). The path adds no money/irreversible
 * action: `message/send` only creates a reversible task and narrates it; the task payload is DATA.
 */

// The coordination env knobs this test flips per-case. The dynamic owner workspace id is filled in at
// runtime (the workspace is created by signup), then the gates resolve ON for exactly that workspace.
const COORDINATION_ENV_KEYS = [
  "RELOAD_AGENT_REGISTRY_ENABLED",
  "RELOAD_AGENT_REGISTRY_OWNER_WORKSPACE_ID",
  "RELOAD_AGENT_COLLABORATION_ENABLED",
  "RELOAD_AGENT_COLLABORATION_OWNER_WORKSPACE_ID",
  "RELOAD_AGENT_CHANNEL_POSTING_ENABLED",
  "RELOAD_AGENT_CHANNEL_POSTING_OWNER_WORKSPACE_ID",
] as const;

/** Enable A2A + collaboration + channel-posting for exactly `ownerWorkspaceId` (owner-first). */
function enableCoordinationFor(ownerWorkspaceId: string): void {
  process.env.RELOAD_AGENT_REGISTRY_ENABLED = "true";
  process.env.RELOAD_AGENT_REGISTRY_OWNER_WORKSPACE_ID = ownerWorkspaceId;
  process.env.RELOAD_AGENT_COLLABORATION_ENABLED = "true";
  process.env.RELOAD_AGENT_COLLABORATION_OWNER_WORKSPACE_ID = ownerWorkspaceId;
  process.env.RELOAD_AGENT_CHANNEL_POSTING_ENABLED = "true";
  process.env.RELOAD_AGENT_CHANNEL_POSTING_OWNER_WORKSPACE_ID = ownerWorkspaceId;
}

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterEach(() => {
  // Restore the default-OFF posture between cases so leakage can never enable posting for another test.
  for (const k of COORDINATION_ENV_KEYS) delete process.env[k];
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `coord-${newId()}`;
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

async function ensureDepartmentChannel(workspaceId: string, name: string): Promise<{ id: string }> {
  const existing = (await listChannels(workspaceId)).find((c) => c.name === name);
  if (existing) return { id: existing.id };
  return createChannel({ workspaceId, kind: "public", name });
}

async function bridgeResolvedAgentMemberId(workspaceId: string, handle: string): Promise<string> {
  const member = await getAgentMemberByHandle(workspaceId, handle);
  expect(member, `expected @${handle} to resolve to an active agent member`).toBeTruthy();
  return member!.memberId;
}

/** Register an agent whose @handle (display name) is a real department handle so the bridge can route it. */
async function newAgent(
  owner: { cookie: string; workspaceId: string },
  handle: string,
): Promise<{ memberId: string; agentId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name: handle },
    })
  ).json();
  return { memberId: reg.memberId, agentId: reg.agentId, token: reg.token };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const rpc = (method: string, params: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

async function waitForMessages(
  channelId: string,
  afterMessageId: string | null,
  match: (messages: Awaited<ReturnType<typeof listChannelMessages>>) => boolean,
  label: string,
): Promise<Awaited<ReturnType<typeof listChannelMessages>>> {
  const deadline = Date.now() + 2_000;
  let messages = await listChannelMessagesAfter(channelId, afterMessageId);
  while (!match(messages) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    messages = await listChannelMessagesAfter(channelId, afterMessageId);
  }
  expect(messages, label).toSatisfy(match);
  return messages;
}

async function listChannelMessagesAfter(
  channelId: string,
  afterMessageId: string | null,
): Promise<Awaited<ReturnType<typeof listChannelMessages>>> {
  const messages = await listChannelMessages(channelId);
  return afterMessageId ? messages.filter((m) => m.id > afterMessageId) : messages;
}

/** Drive a delegation: scout hands `task` off to quill via JSON-RPC `message/send`. Returns the task id. */
async function delegate(
  senderToken: string,
  receiverAgentId: string,
  task: string,
): Promise<string> {
  const send = await app.inject({
    method: "POST",
    url: `/a2a/agents/${receiverAgentId}`,
    headers: bearer(senderToken),
    payload: rpc("message/send", {
      message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: task }] },
    }),
  });
  expect(send.statusCode).toBe(200);
  return send.json().result.id as string;
}

describe("#361 coordination acceptance — delegate → handoff appears in the channel", () => {
  it("posts a handoff status line + inline task card into the receiver's department channel (owner enabled)", async () => {
    const owner = await newOwner();
    // Scout (SEO lead) delegates to Quill (Content). Both @handles are real department handles, so the
    // bridge resolves Quill's department → the "content" channel.
    const scout = await newAgent(owner, "scout");
    const quill = await newAgent(owner, "quill");
    // The bridge posts to the first department channel matching the blueprint name.
    const content = await ensureDepartmentChannel(owner.workspaceId, "content");
    const beforeDelegation = await latestMessageId(content.id);

    enableCoordinationFor(owner.workspaceId);
    const bridgeScoutMemberId = await bridgeResolvedAgentMemberId(owner.workspaceId, "scout");
    const bridgeQuillMemberId = await bridgeResolvedAgentMemberId(owner.workspaceId, "quill");

    const task = "Draft the launch announcement blog from the SEO brief";
    const taskId = await delegate(scout.token, quill.agentId, task);

    const messages = await waitForMessages(
      content.id,
      beforeDelegation,
      (rows) =>
        rows.some((m) => m.body.includes("Handing this off to @quill")) &&
        rows.some((m) => m.body.startsWith("📋 Task")),
      "expected handoff narration in #content",
    );

    // The delegating lead (scout) posts the handoff status line naming the assignee + the (DATA) task.
    const handoff = messages.find((m) => m.body.includes("Handing this off to @quill"));
    expect(handoff, "expected a handoff line in #content").toBeTruthy();
    expect(handoff!.authorMemberId).toBe(bridgeScoutMemberId);
    expect(handoff!.body).toContain(task);

    // The assignee (quill) posts the inline task card linking the created task id.
    const card = messages.find((m) => m.body.startsWith("📋 Task"));
    expect(card, "expected an inline task card in #content").toBeTruthy();
    expect(card!.authorMemberId).toBe(bridgeQuillMemberId);
    expect(card!.body).toContain("@quill");
    expect(card!.body).toContain(taskId.slice(0, 8)); // the card references the real task id

    // The handoff genuinely created the assigned task (the narration sits on top of a real audited write).
    const native = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}`,
      cookies: { rid: owner.cookie },
    });
    expect(native.json().assigneeMemberId).toBe(quill.memberId);
    expect(native.json().labels).toContain("a2a");
  });

  it("stays quiet by DEFAULT (posting off) — the task is created but nothing is posted", async () => {
    const owner = await newOwner();
    const scout = await newAgent(owner, "scout");
    const quill = await newAgent(owner, "quill");
    const content = await ensureDepartmentChannel(owner.workspaceId, "content");
    const beforeDelegation = await latestMessageId(content.id);

    // No coordination env set ⇒ channel posting is OFF (the prod default).
    const taskId = await delegate(scout.token, quill.agentId, "should not be narrated");

    expect(await listChannelMessagesAfter(content.id, beforeDelegation)).toHaveLength(0);
    // …yet the handoff itself still happened (the bridge is best-effort narration, never the write).
    const native = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}`,
      cookies: { rid: owner.cookie },
    });
    expect(native.json().assigneeMemberId).toBe(quill.memberId);
  });

  it("is OWNER-FIRST + fail-closed — posting enabled for a DIFFERENT workspace narrates nothing here", async () => {
    const owner = await newOwner();
    const scout = await newAgent(owner, "scout");
    const quill = await newAgent(owner, "quill");
    const content = await ensureDepartmentChannel(owner.workspaceId, "content");
    const beforeDelegation = await latestMessageId(content.id);

    // Posting is enabled, but named for some OTHER owner workspace — this workspace must stay quiet.
    enableCoordinationFor(`someone-else-${newId()}`);
    await delegate(scout.token, quill.agentId, "still should not be narrated");

    expect(await listChannelMessagesAfter(content.id, beforeDelegation)).toHaveLength(0);
  });
});
