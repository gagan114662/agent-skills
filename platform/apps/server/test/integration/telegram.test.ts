import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { newId } from "../../src/db/id.js";
import { closeRedis } from "../../src/redis/index.js";
import { channelPoster } from "../../src/runtime/default.js";
import type { CodexSubscriptionStatus, CodexSubscriptionStatusProvider } from "../../src/routes/team.js";
import type { LaunchInput, SessionLogger } from "../../src/runtime/manager.js";
import { TeamChannel } from "../../src/team/channel.js";
import { TeamCoordinator } from "../../src/team/coordinator.js";
import { TelegramRoomService, type TelegramTransport } from "../../src/telegram/service.js";
import { WhatsAppRoomService } from "../../src/whatsapp/service.js";
import { createExternalRoomMirror, setExternalRoomMirror } from "../../src/messaging/external-room-mirror.js";

let app: FastifyInstance;
let telegramService: TelegramRoomService;
const slugs: string[] = [];
const originalEnv = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_ROOM_CHAT_ID: process.env.TELEGRAM_ROOM_CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
};
const sendMessage = vi.fn(async () => ({ ok: true, messageId: "42" }));
const teamLaunches: LaunchInput[] = [];
let codexConnected = false;

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const fakeLauncher = {
  launch: vi.fn(async (input: LaunchInput) => {
    teamLaunches.push(input);
    return { id: "telegram-session-" + teamLaunches.length };
  }),
  join: vi.fn(async () => {}),
};

function codexStatus(connected: boolean): CodexSubscriptionStatus {
  return {
    connected,
    reason: connected
      ? "OpenAI ChatGPT subscription auth is ready for Codex agent runs."
      : "Codex subscription auth is not connected for this workspace yet.",
    selectedHarness: "codex",
    userAuthenticated: true,
    workspaceAuthenticated: true,
    runtimeAuth: connected ? "signed_in_subscription" : "missing",
    fallback: "none",
    apiKeySatisfies: false,
  };
}

const codexSubscription: CodexSubscriptionStatusProvider = {
  async status() {
    return codexStatus(codexConnected);
  },
};

function createTeamCoordinator(): TeamCoordinator {
  return new TeamCoordinator({
    launcher: fakeLauncher,
    channel: new TeamChannel({
      poster: channelPoster,
      publish: async () => {},
      listMessages: listChannelMessages,
    }),
    maxConcurrency: 4,
    logger: silentLogger,
  });
}

function buildTelegramTestApp(service: TelegramRoomService): FastifyInstance {
  return buildApp({
    telegram: service,
    teamCoordinator: createTeamCoordinator(),
    codexSubscription,
  });
}

function restoreExternalRoomMirror(): void {
  if (!telegramService) return;
  setExternalRoomMirror(
    createExternalRoomMirror({
      telegram: telegramService,
      whatsapp: new WhatsAppRoomService({ apiBaseUrl: "https://graph.test/v20.0", maxChars: 3500 }),
      log: silentLogger,
    }),
  );
}

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  delete process.env.TELEGRAM_ROOM_CHAT_ID;
  process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-secret";
  const transport: TelegramTransport = { sendMessage };
  telegramService = new TelegramRoomService(
    {
      botToken: "bot-token",
      webhookSecret: "telegram-secret",
      apiBaseUrl: "https://telegram.test",
      maxChars: 3500,
    },
    transport,
  );
  app = buildTelegramTestApp(telegramService);
  await app.ready();
});

afterEach(() => {
  sendMessage.mockClear();
  fakeLauncher.launch.mockClear();
  fakeLauncher.join.mockClear();
  teamLaunches.length = 0;
  codexConnected = false;
  restoreExternalRoomMirror();
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

async function newOwner(targetApp: FastifyInstance = app): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `telegram-${newId()}`;
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

async function createChannel(
  owner: { cookie: string; workspaceId: string },
  name = "telegram-room",
  targetApp: FastifyInstance = app,
): Promise<string> {
  const res = await targetApp.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/channels`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function newAgent(owner: { cookie: string; workspaceId: string }, name: string): Promise<{ token: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/agents`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return { token: res.json().token as string };
}

async function waitForLaunches(count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (teamLaunches.length < count) {
    if (Date.now() > deadline) throw new Error("expected " + count + " team launches, saw " + teamLaunches.length);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForSendContaining(text: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!sendMessage.mock.calls.some((call) => String(call[0].text).includes(text))) {
    if (Date.now() > deadline) throw new Error("expected Telegram send containing " + text);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Telegram room bridge (#1267)", () => {
  it("automatically mirrors signed-in web room messages to Telegram (#1424)", async () => {
    const owner = await newOwner();
    const channelId = await createChannel(owner);
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/enable",
      cookies: { rid: owner.cookie },
      payload: { chatId: "445566" },
    });
    expect(enable.statusCode).toBe(200);

    const posted = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      cookies: { rid: owner.cookie },
      payload: { body: "web room update for Telegram" },
    });

    expect(posted.statusCode).toBe(201);
    expect(sendMessage).toHaveBeenCalledWith({
      botToken: "bot-token",
      apiBaseUrl: "https://telegram.test",
      chatId: "445566",
      text: expect.stringContaining(`ref: tg:${channelId}:${posted.json().id}`),
    });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain("Gagan: web room update for Telegram");
    expect(sendMessage.mock.calls[0]?.[0].text).not.toContain("workspace:");

    sendMessage.mockClear();
    const reply = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages/${posted.json().id}/replies`,
      cookies: { rid: owner.cookie },
      payload: { body: "thread reply for Telegram" },
    });
    expect(reply.statusCode).toBe(201);
    expect(sendMessage.mock.calls[0]?.[0].text).toContain("Gagan: reply: thread reply for Telegram");
  });

  it("does not persist a Telegram room start when deployment sender config is missing", async () => {
    const misconfiguredApp = buildTelegramTestApp(
      new TelegramRoomService(
        {
          webhookSecret: "telegram-secret",
          apiBaseUrl: "https://telegram.test",
          maxChars: 3500,
        },
        { sendMessage },
      ),
    );
    await misconfiguredApp.ready();
    try {
      const owner = await newOwner(misconfiguredApp);
      const channelId = await createChannel(owner, "telegram-missing-sender", misconfiguredApp);
      const enable = await misconfiguredApp.inject({
        method: "POST",
        url: "/me/connections/telegram_room/enable",
        cookies: { rid: owner.cookie },
        payload: { chatId: "123456" },
      });
      expect(enable.statusCode).toBe(200);

      const started = await misconfiguredApp.inject({
        method: "POST",
        url: `/channels/${channelId}/telegram/room`,
        cookies: { rid: owner.cookie },
        payload: { text: "agents, show the Telegram room" },
      });
      expect(started.statusCode).toBe(503);
      expect(started.json()).toMatchObject({
        status: "not_configured",
        missingEnv: ["TELEGRAM_BOT_TOKEN"],
      });
      expect(started.json().message).toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
      await expect(listChannelMessages(channelId)).resolves.toHaveLength(0);
    } finally {
      await misconfiguredApp.close();
    }
  });

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

    const missingDestination = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/enable",
      cookies: { rid: owner.cookie },
    });
    expect(missingDestination.statusCode).toBe(400);

    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/enable",
      cookies: { rid: owner.cookie },
      payload: { chatId: "123456" },
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
      providerMessageId: "42",
      receipt: `telegram:${channelId}:${started.json().message.id}`,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      botToken: "bot-token",
      apiBaseUrl: "https://telegram.test",
      chatId: "123456",
      text: expect.stringContaining(`ref: tg:${channelId}:${started.json().message.id}`),
    });
    await expect(listChannelMessages(channelId)).resolves.toHaveLength(1);

    const unsigned = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          chat: { id: 123456 },
          text: "tell Scout to compare competitors",
          reply_to_message: { message_id: 42 },
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
          reply_to_message: { message_id: 42 },
        },
      },
    });
    expect(wrongChat.statusCode).toBe(400);

    const inbound = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          message_id: 43,
          chat: { id: 123456 },
          text: "YES ship homepage because the draft is approved",
          reply_to_message: { message_id: 42 },
        },
      },
    });
    expect(inbound.statusCode).toBe(201);
    expect(inbound.json()).toMatchObject({
      status: "ingested",
      receipt: "telegram-provider:42",
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

    const readiness = await app.inject({
      method: "GET",
      url: "/me/messaging-readiness",
      cookies: { rid: owner.cookie },
    });
    expect(readiness.statusCode).toBe(200);
    const telegramReadiness = readiness
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === "telegram");
    expect(telegramReadiness).toMatchObject({
      state: "healthy",
      healthy: true,
      latestOutboundProof: {
        channelId,
        messageId: started.json().message.id,
        providerConversationId: "123456",
        providerMessageId: "42",
      },
      latestInboundProof: {
        channelId,
        messageId: inbound.json().message.id,
        replyToMessageId: started.json().message.id,
        providerConversationId: "123456",
        providerMessageId: "43",
      },
    });

    const agent = await newAgent(owner, `agent-${newId()}`);
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { actionType: "billing.refund", payload: { paymentIntentId: "pi_telegram", reason: "duplicate" } },
    });
    expect(submit.statusCode).toBe(202);
    const rid = submit.json().request.id as string;

    const approval = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          chat: { id: 123456 },
          text: `YES approval ${rid} because reviewed in the room`,
          reply_to_message: { message_id: 42 },
        },
      },
    });
    expect(approval.statusCode).toBe(201);
    expect(approval.json()).toMatchObject({
      approvalDecision: { status: "executed", request: { id: rid, decidedByMemberId: owner.memberId } },
    });
    const request = (
      await app.inject({ method: "GET", url: `/approvals/${rid}`, cookies: { rid: owner.cookie } })
    ).json();
    expect(request.status).toBe("executed");
  });

  it("blocks a first inbound room launch with a visible Codex auth reason (#1423)", async () => {
    const owner = await newOwner();
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/enable",
      cookies: { rid: owner.cookie },
      payload: { chatId: "223344" },
    });
    expect(enable.statusCode).toBe(200);

    const inbound = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          message_id: 777,
          chat: { id: 223344 },
          text: "market ipop.ai",
        },
      },
    });

    expect(inbound.statusCode).toBe(202);
    expect(inbound.json()).toMatchObject({
      status: "blocked_auth",
      codexStatus: { runtimeAuth: "missing" },
      providerReply: { status: "sent", chatId: "223344" },
    });
    expect(fakeLauncher.launch).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      botToken: "bot-token",
      apiBaseUrl: "https://telegram.test",
      chatId: "223344",
      text: expect.stringContaining("Codex subscription auth is not connected"),
    });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain("https://ipop.ai/everyday");
    const messages = await listChannelMessages(inbound.json().channelId);
    expect(messages.map((m) => m.body)).toEqual(
      expect.arrayContaining([
        "market ipop.ai",
        expect.stringContaining("Blocked before starting the Codex marketing team"),
      ]),
    );
  });

  it("lets a first inbound Telegram message start the Codex marketing team room once (#1423)", async () => {
    codexConnected = true;
    const owner = await newOwner();
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/enable",
      cookies: { rid: owner.cookie },
      payload: { chatId: "334455" },
    });
    expect(enable.statusCode).toBe(200);

    const payload = {
      message: {
        message_id: 888,
        chat: { id: 334455 },
        text: "market ipop.ai",
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      status: "launched",
      subtaskCount: 4,
      providerReply: { status: "sent", chatId: "334455" },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      botToken: "bot-token",
      apiBaseUrl: "https://telegram.test",
      chatId: "334455",
      text: expect.stringContaining("Scout, Quill, Echo, and Bid are starting"),
    });
    await waitForLaunches(4);
    await waitForSendContaining("started:");
    expect(new Set(teamLaunches.map((launch) => launch.teamRunId))).toEqual(new Set([first.json().teamRunId]));
    expect(teamLaunches.map((launch) => launch.harness)).toEqual(["codex", "codex", "codex", "codex"]);
    expect((await listChannelMessages(first.json().channelId)).map((m) => m.body)).toContain("market ipop.ai");

    const duplicate = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      status: "duplicate",
      messageId: first.json().messageId,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(teamLaunches).toHaveLength(4);

    const laterReply = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          message_id: 889,
          chat: { id: 334455 },
          text: "add LinkedIn founder posts",
          reply_to_message: { message_id: 888 },
        },
      },
    });
    expect(laterReply.statusCode).toBe(201);
    expect(laterReply.json()).toMatchObject({
      status: "ingested",
      message: {
        channelId: first.json().channelId,
        parentMessageId: first.json().messageId,
        alsoSentToChannel: true,
      },
    });
  });
});
