import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { newId } from "../../src/db/id.js";
import { closeRedis } from "../../src/redis/index.js";
import { TelegramRoomService, type TelegramTransport } from "../../src/telegram/service.js";

let app: FastifyInstance;
const slugs: string[] = [];
const originalEnv = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_ROOM_CHAT_ID: process.env.TELEGRAM_ROOM_CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
};
const sendMessage = vi.fn(async () => ({ ok: true, messageId: "telegram-message-42" }));

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.TELEGRAM_ROOM_CHAT_ID = "123456";
  process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-secret";
  const transport: TelegramTransport = { sendMessage };
  app = buildApp({
    telegram: new TelegramRoomService(
      {
        botToken: "bot-token",
        roomChatId: "123456",
        webhookSecret: "telegram-secret",
        apiBaseUrl: "https://telegram.test",
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

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `telegram-${newId()}`;
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

async function createChannel(owner: { cookie: string; workspaceId: string }, name = "telegram-room"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/channels`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("Telegram room bridge (#1267)", () => {
  it("connects a configured Telegram room, mirrors room events, and ingests signed replies", async () => {
    const owner = await newOwner();
    const channelId = await createChannel(owner);

    const before = await app.inject({
      method: "GET",
      url: "/me/connections",
      cookies: { rid: owner.cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().connections.find((c: { id: string }) => c.id === "telegram_room")).toMatchObject({
      status: "available",
      connected: false,
      providerStatus: "unproven",
    });

    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/enable",
      cookies: { rid: owner.cookie },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({
      connected: true,
      id: "telegram_room",
      providerStatus: "healthy",
    });

    const started = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/telegram/room`,
      cookies: { rid: owner.cookie },
      payload: { text: "agents, show the Telegram room" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      status: "sent",
      chatId: "123456",
      providerMessageId: "telegram-message-42",
      receipt: `telegram:${channelId}:${started.json().message.id}`,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      botToken: "bot-token",
      apiBaseUrl: "https://telegram.test",
      chatId: "123456",
      text: expect.stringContaining(`receipt: telegram:${channelId}:${started.json().message.id}`),
    });
    await expect(listChannelMessages(channelId)).resolves.toHaveLength(1);

    const unsigned = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          chat: { id: 123456 },
          text: "tell Scout to compare competitors",
          reply_to_message: { text: `receipt: telegram:${channelId}:${started.json().message.id}` },
        },
      },
    });
    expect(unsigned.statusCode).toBe(401);

    const wrongChat = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          chat: { id: 999999 },
          text: "try to spoof the room",
          reply_to_message: { text: `receipt: telegram:${channelId}:${started.json().message.id}` },
        },
      },
    });
    expect(wrongChat.statusCode).toBe(403);

    const inbound = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          chat: { id: 123456 },
          text: "YES ship homepage because the draft is approved",
          reply_to_message: { text: `receipt: telegram:${channelId}:${started.json().message.id}` },
        },
      },
    });
    expect(inbound.statusCode).toBe(201);
    expect(inbound.json()).toMatchObject({
      status: "ingested",
      command: {
        kind: "approval_decision",
        decision: "approve",
        target: "ship homepage",
        reason: "the draft is approved",
      },
      message: {
        channelId,
        authorMemberId: owner.memberId,
        parentMessageId: started.json().message.id,
        alsoSentToChannel: true,
      },
    });
    expect((await listChannelMessages(channelId)).map((m) => m.body)).toEqual([
      "agents, show the Telegram room",
      "YES ship homepage because the draft is approved",
    ]);
  });
});

