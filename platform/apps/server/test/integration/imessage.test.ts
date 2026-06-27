import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { newId } from "../../src/db/id.js";
import { closeRedis } from "../../src/redis/index.js";
import { IMessageRelayService } from "../../src/imessage/service.js";

let app: FastifyInstance;
const slugs: string[] = [];
const send = vi.fn(async () => undefined);

beforeAll(async () => {
  const service = new IMessageRelayService(
    { enabled: true, dryRun: false, maxChars: 2000 },
    { send },
  );
  app = buildApp({ imessage: service });
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
  await closeRedis();
});

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `imessage-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email: `u-${newId()}@e.com`,
      password: "pwpwpwpw",
      displayName: "Gagan",
      workspaceSlug: slug,
    },
  });
  expect(signup.statusCode).toBe(201);
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function createChannel(owner: { cookie: string; workspaceId: string }, name = "general"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/channels`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("iMessage member recipient relay", () => {
  it("blocks agent-room relay until the signed-in user's iMessage recipient is verified (#1283)", async () => {
    send.mockClear();
    const owner = await newOwner();
    const channelId = await createChannel(owner);

    const initial = await app.inject({
      method: "GET",
      url: "/me/imessage/status",
      cookies: { rid: owner.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      configured: false,
      recipientSource: "none",
      memberRecipient: null,
    });

    const saveRecipient = await app.inject({
      method: "PUT",
      url: "/me/imessage/recipient",
      cookies: { rid: owner.cookie },
      payload: { recipient: "GAGAN@Example.COM", serviceName: "E:test" },
    });
    expect(saveRecipient.statusCode).toBe(202);
    expect(saveRecipient.json()).toMatchObject({
      status: "pending_verification",
      recipient: "gagan@example.com",
      serviceName: "E:test",
      verified: false,
    });

    const pending = await app.inject({
      method: "GET",
      url: "/me/imessage/status",
      cookies: { rid: owner.cookie },
    });
    expect(pending.json()).toMatchObject({
      configured: false,
      recipient: "gagan@example.com",
      recipientSource: "member_pending",
      requiresVerification: true,
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: "E:test",
        verified: false,
      },
    });

    const blocked = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/imessage/room`,
      cookies: { rid: owner.cookie },
      payload: { text: "show the team working in messages" },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({
      status: "not_configured",
      error: "Verify this iMessage recipient with a successful test send before starting the room.",
    });
    await expect(listChannelMessages(channelId)).resolves.toHaveLength(0);
    expect(send).not.toHaveBeenCalled();

    const testSend = await app.inject({
      method: "POST",
      url: "/me/imessage/test",
      cookies: { rid: owner.cookie },
      payload: { text: "ipop test" },
    });
    expect(testSend.statusCode).toBe(200);
    expect(testSend.json()).toMatchObject({
      status: "sent",
      recipient: "gagan@example.com",
      memberRecipient: { recipient: "gagan@example.com", serviceName: "E:test", verified: true },
    });
    expect(send).toHaveBeenLastCalledWith({
      recipient: "gagan@example.com",
      serviceName: "E:test",
      text: "ipop test",
    });

    const verified = await app.inject({
      method: "GET",
      url: "/me/imessage/status",
      cookies: { rid: owner.cookie },
    });
    expect(verified.json()).toMatchObject({
      configured: true,
      recipient: "gagan@example.com",
      recipientSource: "member_verified",
      requiresVerification: false,
      memberRecipient: { recipient: "gagan@example.com", verified: true },
    });

    const started = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/imessage/room`,
      cookies: { rid: owner.cookie },
      payload: { text: "agents, get to work" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      status: "sent",
      recipient: "gagan@example.com",
      receipt: `imessage:${channelId}:${started.json().message.id}`,
    });
    await expect(listChannelMessages(channelId)).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      recipient: "gagan@example.com",
      serviceName: "E:test",
      text: expect.stringContaining(`receipt: imessage:${channelId}:${started.json().message.id}`),
    });
  });

  it("resets verification when the user changes their iMessage recipient", async () => {
    send.mockClear();
    const owner = await newOwner();
    const channelId = await createChannel(owner, "launch");

    await app.inject({
      method: "PUT",
      url: "/me/imessage/recipient",
      cookies: { rid: owner.cookie },
      payload: { recipient: "+1 (555) 111-2222" },
    });
    const firstTest = await app.inject({
      method: "POST",
      url: "/me/imessage/test",
      cookies: { rid: owner.cookie },
    });
    expect(firstTest.statusCode).toBe(200);
    expect(firstTest.json().memberRecipient).toMatchObject({ recipient: "+15551112222", verified: true });

    const update = await app.inject({
      method: "PUT",
      url: "/me/imessage/recipient",
      cookies: { rid: owner.cookie },
      payload: { recipient: "new@example.com" },
    });
    expect(update.statusCode).toBe(202);

    const blocked = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/imessage/room`,
      cookies: { rid: owner.cookie },
      payload: { text: "use the new destination" },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ status: "not_configured" });
    await expect(listChannelMessages(channelId)).resolves.toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
