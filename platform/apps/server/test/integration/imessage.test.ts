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
  app = buildApp({ imessage: service, imessageWebhookSecret: "relay-secret" });
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
  await closeRedis();
});

async function newOwner(targetApp = app): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `imessage-${newId()}`;
  slugs.push(slug);
  const signup = await targetApp.inject({
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
  const me = (await targetApp.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function createChannel(owner: { cookie: string; workspaceId: string }, name = "general", targetApp = app): Promise<string> {
  const res = await targetApp.inject({
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

  it("ingests a signed inbound iMessage reply into the correlated ipop room (#1283)", async () => {
    send.mockClear();
    const owner = await newOwner();
    const channelId = await createChannel(owner, "messages-room");

    await app.inject({
      method: "PUT",
      url: "/me/imessage/recipient",
      cookies: { rid: owner.cookie },
      payload: { recipient: "gagan@example.com" },
    });
    const testSend = await app.inject({
      method: "POST",
      url: "/me/imessage/test",
      cookies: { rid: owner.cookie },
    });
    expect(testSend.statusCode).toBe(200);

    const started = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/imessage/room`,
      cookies: { rid: owner.cookie },
      payload: { text: "start in messages" },
    });
    expect(started.statusCode).toBe(200);
    const receipt = started.json().receipt as string;
    const rootMessageId = started.json().message.id as string;

    const unsigned = await app.inject({
      method: "POST",
      url: "/imessage/relay/inbound",
      payload: {
        workspaceId: owner.workspaceId,
        receipt,
        sender: "gagan@example.com",
        text: "tell Scout to compare competitors",
      },
    });
    expect(unsigned.statusCode).toBe(401);

    const wrongSender = await app.inject({
      method: "POST",
      url: "/imessage/relay/inbound",
      headers: { "x-ipop-imessage-relay-secret": "relay-secret" },
      payload: {
        workspaceId: owner.workspaceId,
        receipt,
        sender: "other@example.com",
        text: "try to spoof the room",
      },
    });
    expect(wrongSender.statusCode).toBe(403);

    const inbound = await app.inject({
      method: "POST",
      url: "/imessage/relay/inbound",
      headers: { "x-ipop-imessage-relay-secret": "relay-secret" },
      payload: {
        workspaceId: owner.workspaceId,
        receipt,
        sender: "GAGAN@Example.COM",
        text: "tell Scout to compare competitors",
      },
    });
    expect(inbound.statusCode).toBe(201);
    expect(inbound.json()).toMatchObject({
      status: "ingested",
      receipt,
      command: null,
      message: {
        channelId,
        authorMemberId: owner.memberId,
        parentMessageId: rootMessageId,
        alsoSentToChannel: true,
        body: "tell Scout to compare competitors",
      },
    });
    const messages = await listChannelMessages(channelId);
    expect(messages.map((m) => m.body)).toEqual(["start in messages", "tell Scout to compare competitors"]);

    const command = await app.inject({
      method: "POST",
      url: "/imessage/relay/inbound",
      headers: { "x-ipop-imessage-relay-secret": "relay-secret" },
      payload: {
        workspaceId: owner.workspaceId,
        receipt,
        sender: "gagan@example.com",
        text: "YES ship homepage because the draft is approved",
      },
    });
    expect(command.statusCode).toBe(201);
    expect(command.json()).toMatchObject({
      status: "ingested",
      command: {
        kind: "approval_decision",
        decision: "approve",
        target: "ship homepage",
        reason: "the draft is approved",
      },
    });
  });

  it("queues outbound work for a signed Mac relay worker when direct Apple Messages is unavailable (#1341)", async () => {
    const queuedApp = buildApp({
      imessage: new IMessageRelayService(
        { enabled: false, dryRun: false, maxChars: 2000 },
        { send },
      ),
      imessageWebhookSecret: "relay-secret",
    });
    await queuedApp.ready();
    try {
      send.mockClear();
      const owner = await newOwner(queuedApp);
      const channelId = await createChannel(owner, "mac-relay-room", queuedApp);

      await queuedApp.inject({
        method: "PUT",
        url: "/me/imessage/recipient",
        cookies: { rid: owner.cookie },
        payload: { recipient: "gagan@example.com", serviceName: "E:test" },
      });

      const testSend = await queuedApp.inject({
        method: "POST",
        url: "/me/imessage/test",
        cookies: { rid: owner.cookie },
        payload: { text: "verify me over the Mac relay" },
      });
      expect(testSend.statusCode).toBe(202);
      expect(testSend.json()).toMatchObject({
        status: "queued",
        recipient: "gagan@example.com",
        memberRecipient: { verified: false },
      });
      expect(testSend.json().jobId).toEqual(expect.any(String));
      expect(send).not.toHaveBeenCalled();

      const pendingStatus = await queuedApp.inject({
        method: "GET",
        url: "/me/imessage/status",
        cookies: { rid: owner.cookie },
      });
      expect(pendingStatus.statusCode).toBe(200);
      expect(pendingStatus.json()).toMatchObject({
        lastRelayJob: {
          id: testSend.json().jobId,
          purpose: "verification",
          recipient: "gagan@example.com",
          status: "pending",
          text: "verify me over the Mac relay",
        },
      });

      const claimVerification = await queuedApp.inject({
        method: "POST",
        url: "/imessage/relay/outbound/claim",
        headers: { "x-ipop-imessage-relay-secret": "relay-secret" },
        payload: { relayId: "gagan-mac", limit: 1 },
      });
      expect(claimVerification.statusCode).toBe(200);
      expect(claimVerification.json().jobs).toHaveLength(1);
      expect(claimVerification.json().jobs[0]).toMatchObject({
        purpose: "verification",
        recipient: "gagan@example.com",
        serviceName: "E:test",
        text: "verify me over the Mac relay",
        status: "claimed",
      });

      const completeVerification = await queuedApp.inject({
        method: "POST",
        url: `/imessage/relay/outbound/${claimVerification.json().jobs[0].id}/complete`,
        headers: { "x-ipop-imessage-relay-secret": "relay-secret" },
        payload: { relayId: "gagan-mac", status: "sent" },
      });
      expect(completeVerification.statusCode).toBe(200);
      expect(completeVerification.json()).toMatchObject({
        job: { status: "sent", purpose: "verification" },
        memberRecipient: { recipient: "gagan@example.com", verified: true },
      });

      const started = await queuedApp.inject({
        method: "POST",
        url: `/channels/${channelId}/imessage/room`,
        cookies: { rid: owner.cookie },
        payload: { text: "agents, show your work in Messages" },
      });
      expect(started.statusCode).toBe(202);
      expect(started.json()).toMatchObject({
        status: "queued",
        recipient: "gagan@example.com",
        receipt: `imessage:${channelId}:${started.json().message.id}`,
      });
      await expect(listChannelMessages(channelId)).resolves.toHaveLength(1);

      const queuedRoomStatus = await queuedApp.inject({
        method: "GET",
        url: "/me/imessage/status",
        cookies: { rid: owner.cookie },
      });
      expect(queuedRoomStatus.statusCode).toBe(200);
      expect(queuedRoomStatus.json()).toMatchObject({
        lastRelayJob: {
          id: started.json().jobId,
          purpose: "room",
          recipient: "gagan@example.com",
          status: "pending",
          receipt: `imessage:${channelId}:${started.json().message.id}`,
        },
      });

      const claimRoom = await queuedApp.inject({
        method: "POST",
        url: "/imessage/relay/outbound/claim",
        headers: { "x-ipop-imessage-relay-secret": "relay-secret" },
        payload: { relayId: "gagan-mac", limit: 1 },
      });
      expect(claimRoom.statusCode).toBe(200);
      expect(claimRoom.json().jobs[0]).toMatchObject({
        purpose: "room",
        recipient: "gagan@example.com",
        serviceName: "E:test",
        text: expect.stringContaining(`receipt: imessage:${channelId}:${started.json().message.id}`),
        receipt: `imessage:${channelId}:${started.json().message.id}`,
      });
    } finally {
      await queuedApp.close();
    }
  });
});
