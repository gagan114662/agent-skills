import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { newId } from "../../src/db/id.js";
import { closeRedis } from "../../src/redis/index.js";
import { WhatsAppRoomService, type WhatsAppTransport } from "../../src/whatsapp/service.js";

let app: FastifyInstance;
const slugs: string[] = [];
const originalEnv = {
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ROOM_RECIPIENT: process.env.WHATSAPP_ROOM_RECIPIENT,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
};
const sendMessage = vi.fn(async () => ({ ok: true, messageId: "wamid.room.42" }));

beforeAll(async () => {
  process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-id";
  process.env.WHATSAPP_ROOM_RECIPIENT = "15551112222";
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-token";
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  const transport: WhatsAppTransport = { sendMessage };
  app = buildApp({
    whatsapp: new WhatsAppRoomService(
      {
        accessToken: "wa-token",
        phoneNumberId: "phone-id",
        roomRecipient: "15551112222",
        webhookVerifyToken: "verify-token",
        appSecret: "app-secret",
        apiBaseUrl: "https://graph.test/v20.0",
        maxChars: 3500,
      },
      transport,
    ),
  });
  await app.ready();
});

afterEach(() => {
  sendMessage.mockClear();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key as keyof typeof originalEnv];
    else process.env[key as keyof typeof originalEnv] = value;
  }
  await app.close();
  await closeDb();
  await closeRedis();
});

function sign(payload: unknown): string {
  return "sha256=" + createHmac("sha256", "app-secret").update(JSON.stringify(payload)).digest("hex");
}

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `whatsapp-${newId()}`;
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

async function createChannel(owner: { cookie: string; workspaceId: string }, name = "whatsapp-room"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/channels`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("WhatsApp room bridge (#1267)", () => {
  it("connects a configured WhatsApp room, mirrors room events, and ingests signed replies", async () => {
    const owner = await newOwner();
    const channelId = await createChannel(owner);

    const challenge = await app.inject({
      method: "GET",
      url: "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=ok-123",
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.body).toBe("ok-123");

    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/whatsapp_room/enable",
      cookies: { rid: owner.cookie },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({
      connected: true,
      id: "whatsapp_room",
      providerStatus: "healthy",
    });

    const started = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/whatsapp/room`,
      cookies: { rid: owner.cookie },
      payload: { text: "agents, show the WhatsApp room" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      status: "sent",
      recipient: "15551112222",
      providerMessageId: "wamid.room.42",
      receipt: `whatsapp:${channelId}:${started.json().message.id}`,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      accessToken: "wa-token",
      apiBaseUrl: "https://graph.test/v20.0",
      phoneNumberId: "phone-id",
      recipient: "15551112222",
      text: expect.stringContaining(`receipt: whatsapp:${channelId}:${started.json().message.id}`),
    });
    await expect(listChannelMessages(channelId)).resolves.toHaveLength(1);

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551112222",
                    text: {
                      body: `YES ship homepage because the draft is approved receipt: whatsapp:${channelId}:${started.json().message.id}`,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const unsigned = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      payload,
    });
    expect(unsigned.statusCode).toBe(401);

    const wrongSenderPayload = structuredClone(payload);
    wrongSenderPayload.entry[0]!.changes[0]!.value!.messages![0]!.from = "15559990000";
    const wrongSender = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      headers: { "x-hub-signature-256": sign(wrongSenderPayload) },
      payload: wrongSenderPayload,
    });
    expect(wrongSender.statusCode).toBe(403);

    const inbound = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      headers: { "x-hub-signature-256": sign(payload) },
      payload,
    });
    expect(inbound.statusCode).toBe(201);
    expect(inbound.json()).toMatchObject({
      status: "ingested",
      command: {
        kind: "approval_decision",
        decision: "approve",
        target: "ship homepage",
        reason: expect.stringContaining("the draft is approved"),
      },
      message: {
        channelId,
        authorMemberId: owner.memberId,
        parentMessageId: started.json().message.id,
        alsoSentToChannel: true,
      },
    });
    expect((await listChannelMessages(channelId)).map((m) => m.body)).toEqual([
      "agents, show the WhatsApp room",
      `YES ship homepage because the draft is approved receipt: whatsapp:${channelId}:${started.json().message.id}`,
    ]);
  });
});

