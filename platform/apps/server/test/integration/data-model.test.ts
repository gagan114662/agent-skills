import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces, members } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createWorkspace, getWorkspaceBySlug } from "../../src/db/repositories/workspaces.js";
import { createHumanMember, createAgentMember } from "../../src/db/repositories/members.js";
import {
  createChannel,
  addChannelMember,
  isChannelMember,
} from "../../src/db/repositories/channels.js";
import {
  postMessage,
  listChannelMessages,
  softDeleteMessage,
} from "../../src/db/repositories/messages.js";

const created: string[] = [];

async function freshWorkspace() {
  const ws = await createWorkspace({ slug: `test-${newId()}`, name: "Test WS" });
  created.push(ws.id);
  return ws;
}

afterAll(async () => {
  for (const id of created) {
    await db.delete(workspaces).where(eq(workspaces.id, id)); // cascades to children
  }
  await closeDb();
});

describe("data model (real Postgres)", () => {
  it("round-trips workspace → members → channel → message", async () => {
    const ws = await freshWorkspace();
    expect((await getWorkspaceBySlug(ws.slug))?.id).toBe(ws.id);

    const human = await createHumanMember({
      workspaceId: ws.id,
      email: `h-${newId()}@example.com`,
      displayName: "Human",
    });
    const agent = await createAgentMember({ workspaceId: ws.id, name: "Scout", framework: "mcp" });
    expect(human.kind).toBe("human");
    expect(agent.kind).toBe("agent");

    const channel = await createChannel({ workspaceId: ws.id, kind: "public", name: "general" });
    await addChannelMember(channel.id, human.id);
    await addChannelMember(channel.id, agent.id);
    expect(await isChannelMember(channel.id, agent.id)).toBe(true);

    const msg = await postMessage({
      workspaceId: ws.id,
      channelId: channel.id,
      authorMemberId: agent.id,
      body: "hello from an agent",
    });

    const list = await listChannelMessages(channel.id);
    expect(list.map((m) => m.id)).toContain(msg.id);
    expect(list.find((m) => m.id === msg.id)?.authorMemberId).toBe(agent.id);
  });

  it("supports threads via parent_message_id", async () => {
    const ws = await freshWorkspace();
    const human = await createHumanMember({
      workspaceId: ws.id,
      email: `h-${newId()}@example.com`,
      displayName: "Human",
    });
    const channel = await createChannel({ workspaceId: ws.id, kind: "public", name: "general" });
    const parent = await postMessage({
      workspaceId: ws.id,
      channelId: channel.id,
      authorMemberId: human.id,
      body: "parent",
    });
    const reply = await postMessage({
      workspaceId: ws.id,
      channelId: channel.id,
      authorMemberId: human.id,
      body: "reply",
      parentMessageId: parent.id,
    });
    expect(reply.parentMessageId).toBe(parent.id);
  });

  it("soft-deletes messages (excluded from listing, row preserved)", async () => {
    const ws = await freshWorkspace();
    const human = await createHumanMember({
      workspaceId: ws.id,
      email: `h-${newId()}@example.com`,
      displayName: "Human",
    });
    const channel = await createChannel({ workspaceId: ws.id, kind: "public", name: "general" });
    const msg = await postMessage({
      workspaceId: ws.id,
      channelId: channel.id,
      authorMemberId: human.id,
      body: "delete me",
    });
    await softDeleteMessage(msg.id);
    const list = await listChannelMessages(channel.id);
    expect(list.map((m) => m.id)).not.toContain(msg.id);
  });

  it("enforces the members kind/identity CHECK constraint", async () => {
    const ws = await freshWorkspace();
    // kind='human' but no user_id → violates members_kind_identity_ck
    await expect(
      db.insert(members).values({
        workspaceId: ws.id,
        kind: "human",
        displayName: "bad",
      }),
    ).rejects.toThrow();
  });

  it("cascades children when a workspace is deleted (tenant isolation/cleanup)", async () => {
    const ws = await createWorkspace({ slug: `casc-${newId()}`, name: "Cascade WS" });
    const human = await createHumanMember({
      workspaceId: ws.id,
      email: `h-${newId()}@example.com`,
      displayName: "Human",
    });
    const channel = await createChannel({ workspaceId: ws.id, kind: "public", name: "general" });
    await postMessage({
      workspaceId: ws.id,
      channelId: channel.id,
      authorMemberId: human.id,
      body: "x",
    });

    await db.delete(workspaces).where(eq(workspaces.id, ws.id));

    expect(await getWorkspaceBySlug(ws.slug)).toBeUndefined();
    expect(await listChannelMessages(channel.id)).toHaveLength(0);
  });
});
