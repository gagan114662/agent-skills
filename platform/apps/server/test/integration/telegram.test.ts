import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { getExternalRoomMessageReceipt } from "../../src/db/repositories/external-room-message-receipts.js";
import { resolveServiceSecrets } from "../../src/db/repositories/external-credentials.js";
import { newId } from "../../src/db/id.js";
import { closeRedis } from "../../src/redis/index.js";
import { channelPoster } from "../../src/runtime/default.js";
import type { CodexSubscriptionStatus, CodexSubscriptionStatusProvider } from "../../src/routes/team.js";
import type { LaunchInput, SessionLogger } from "../../src/runtime/manager.js";
import { TeamChannel } from "../../src/team/channel.js";
import { TeamCoordinator } from "../../src/team/coordinator.js";
import { encodeTeamEvent } from "../../src/team/protocol.js";
import { TelegramRoomService, type TelegramTransport } from "../../src/telegram/service.js";
import { WhatsAppRoomService } from "../../src/whatsapp/service.js";
import { createExternalRoomMirror, setExternalRoomMirror } from "../../src/messaging/external-room-mirror.js";

let app: FastifyInstance;
let telegramService: TelegramRoomService;
const slugs: string[] = [];
const originalEnv = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
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

function teamEventField(task: string, field: "subtaskId" | "branch"): string | null {
  const match = new RegExp('"' + field + '": "([^"]+)"').exec(task);
  return match?.[1] ?? null;
}

const fakeLauncher = {
  launch: vi.fn(async (input: LaunchInput) => {
    teamLaunches.push(input);
    const taskText = input.task.toLowerCase();
    if (input.teamRunId && taskText.includes("research artifact ready: <domain or target>")) {
      const subtaskId = teamEventField(input.task, "subtaskId") ?? "scout";
      await channelPoster.post({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: input.agentMemberId,
        body: encodeTeamEvent({
          teamRunId: input.teamRunId,
          subtaskId,
          agentMemberId: input.agentMemberId,
          kind: "milestone",
          summary: "research artifact ready: ipop.ai",
          branch: teamEventField(input.task, "branch"),
          artifact: {
            kind: "scout_research",
            schemaVersion: 1,
            siteSummary: "ipop.ai offers a marketing team in your messages.",
            icp: "Founders who want a hands-on AI marketing team",
            positioning: "Messaging-native marketing execution with visible teammates.",
            proofPoints: ["Homepage says marketing team in your messages", "Room names Scout, Quill, Echo, and Bid"],
            competitors: ["agency retainer", "generic chatbot"],
            toneNotes: "Plain, direct, slightly playful.",
            sourceUrls: ["https://ipop.ai"],
          },
          createdAt: new Date(0).toISOString(),
        }),
      });
    }
    if (input.teamRunId && taskText.includes("produce the required draft_set artifact")) {
      const subtaskId = teamEventField(input.task, "subtaskId") ?? "quill";
      await channelPoster.post({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: input.agentMemberId,
        body: encodeTeamEvent({
          teamRunId: input.teamRunId,
          subtaskId,
          agentMemberId: input.agentMemberId,
          kind: "milestone",
          summary: "draft set ready: ipop.ai",
          branch: teamEventField(input.task, "branch"),
          artifact: {
            kind: "draft_set",
            schemaVersion: 1,
            drafts: [
              {
                format: "google_rsa",
                title: "Search ads",
                fields: {
                  headlines: Array.from({ length: 15 }, (_, i) => "Proof ad " + (i + 1)),
                  descriptions: Array.from({ length: 4 }, (_, i) => "Proof-led message for channel " + (i + 1)),
                },
                citations: ["Homepage says marketing team in your messages"],
              },
              {
                format: "email",
                title: "Welcome email",
                fields: {
                  subject: "Your marketing room is ready",
                  preheader: "Scout found the first useful move.",
                  body: "Here is the first draft for review.",
                  cta: "Review the draft",
                  plainTextAlt: "Review the first draft in ipop.",
                },
                citations: ["Homepage says marketing team in your messages"],
              },
              {
                format: "landing_hero",
                title: "Homepage hero",
                fields: {
                  headline: "Marketing work, visible in messages",
                  subhead: "Scout researches, Quill drafts, and every send waits for your approval.",
                  cta: "Start the room",
                },
                citations: ["Homepage says marketing team in your messages"],
              },
              {
                format: "seo_snippet",
                title: "SEO snippet",
                fields: {
                  title: "AI marketing team in your messages",
                  metaDescription: "AI teammates research your site, draft channel-ready marketing work, and keep every send or spend behind approval while you watch progress in messages.",
                  intent: "brand-aware marketing team software",
                },
                citations: ["Homepage says marketing team in your messages"],
              },
              {
                format: "x_thread",
                title: "X thread",
                fields: { tweets: ["Your marketing team should show its work.", "Scout researches, Quill drafts, and you approve before anything ships."] },
                citations: ["Room names Scout, Quill, Echo, and Bid"],
              },
            ],
          },
          createdAt: new Date(0).toISOString(),
        }),
      });
    }
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
  process.env.TELEGRAM_BOT_USERNAME = "ipopmarketingbot";
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

async function newAgent(owner: { cookie: string; workspaceId: string }, name: string): Promise<{ memberId: string; token: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/agents`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return { memberId: res.json().memberId as string, token: res.json().token as string };
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

async function expectNoSendContaining(text: string): Promise<void> {
  const deadline = Date.now() + 250;
  while (Date.now() <= deadline) {
    expect(sendMessage.mock.calls.some((call) => String(call[0].text).includes(text))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForProviderReceipt(providerConversationId: string, providerMessageId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    !(await getExternalRoomMessageReceipt({
      provider: "telegram",
      providerConversationId,
      providerMessageId,
    }))
  ) {
    if (Date.now() > deadline) {
      throw new Error("expected Telegram receipt " + providerConversationId + "/" + providerMessageId);
    }
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

  it("authors Telegram replies to agent updates as the connected human, not the agent", async () => {
    const owner = await newOwner();
    const channelId = await createChannel(owner);
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/enable",
      cookies: { rid: owner.cookie },
      payload: { chatId: "778899" },
    });
    expect(enable.statusCode).toBe(200);
    const agent = await newAgent(owner, `scout-${newId()}`);

    sendMessage.mockClear();
    const agentPost = await channelPoster.post({
      workspaceId: owner.workspaceId,
      channelId,
      agentMemberId: agent.memberId,
      body: "Scout finished the competitor readout",
    });
    await waitForSendContaining(`ref: tg:${channelId}:${agentPost.id}`);
    await waitForProviderReceipt("778899", "42");

    const inbound = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          message_id: 99,
          chat: { id: 778899 },
          text: "tighten the launch angle",
          reply_to_message: { message_id: 42 },
        },
      },
    });

    expect(inbound.statusCode).toBe(201);
    expect(inbound.json()).toMatchObject({
      status: "ingested",
      message: {
        channelId,
        authorMemberId: owner.memberId,
        parentMessageId: agentPost.id,
        alsoSentToChannel: true,
      },
    });
    expect(inbound.json().message.authorMemberId).not.toBe(agent.memberId);
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
      connected: false,
      id: "telegram_room",
      consentStatus: "recorded",
      providerStatus: "unproven",
    });
    const afterEnable = await app.inject({
      method: "GET",
      url: "/me/connections",
      cookies: { rid: owner.cookie },
    });
    expect(afterEnable.json().connections.find((c: { id: string }) => c.id === "telegram_room")).toMatchObject({
      connected: false,
      consentStatus: "recorded",
      providerStatus: "unproven",
      failureReason: expect.stringMatching(/same-thread Telegram send and reply proof/i),
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
    const afterRoundTrip = await app.inject({
      method: "GET",
      url: "/me/connections",
      cookies: { rid: owner.cookie },
    });
    expect(afterRoundTrip.json().connections.find((c: { id: string }) => c.id === "telegram_room")).toMatchObject({
      connected: true,
      consentStatus: "recorded",
      providerStatus: "healthy",
      lastProofReceipt: expect.stringMatching(/^external-room:telegram:/),
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

  it("blocks a first inbound room launch with customer-safe agent runtime copy (#1423)", async () => {
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
      text: expect.stringContaining("the agent runtime is not connected"),
    });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain("https://ipop.ai/everyday");
    expect(sendMessage.mock.calls[0]?.[0].text).not.toContain("Codex subscription auth");
    const messages = await listChannelMessages(inbound.json().channelId);
    const bodies = messages.map((m) => m.body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        "market ipop.ai",
        expect.stringContaining("The marketing team is ready"),
      ]),
    );
    expect(bodies.join("\n")).not.toContain("Codex subscription auth");
  });

  it("binds Telegram from a bot-native /start code without exposing chat ids (#1267)", async () => {
    const owner = await newOwner();
    const link = await app.inject({
      method: "POST",
      url: "/me/connections/telegram_room/link",
      cookies: { rid: owner.cookie },
    });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({
      status: "pending_telegram_start",
      botUsername: "ipopmarketingbot",
      startUrl: expect.stringContaining("https://t.me/ipopmarketingbot?start="),
    });
    expect(link.json().startCommand).toMatch(/^\/start [A-Za-z0-9_-]{16,64}$/);

    const connected = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          message_id: 900,
          chat: { id: 987654 },
          text: link.json().startCommand,
        },
      },
    });

    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      status: "connected",
      workspaceId: owner.workspaceId,
      memberId: owner.memberId,
      providerReply: { status: "sent", chatId: "987654" },
    });
    await expect(resolveServiceSecrets(owner.workspaceId, "telegram_room")).resolves.toMatchObject({
      TELEGRAM_CHAT_ID: "987654",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      botToken: "bot-token",
      apiBaseUrl: "https://telegram.test",
      chatId: "987654",
      text: expect.stringContaining("Telegram is connected to your ipop marketing room"),
    });
    expect(sendMessage.mock.calls.at(-1)?.[0].text).toContain('Try: "market ipop.ai to SaaS founders"');

    const reused = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
      payload: {
        message: {
          message_id: 901,
          chat: { id: 987654 },
          text: link.json().startCommand,
        },
      },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ status: "expired" });
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
      text: expect.stringContaining("Scout, Quill, Echo, and Bid are in the room"),
    });
    await waitForLaunches(4);
    await expectNoSendContaining("started:");
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
