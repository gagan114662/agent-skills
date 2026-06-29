import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { getExternalRoomMessageReceipt } from "../../src/db/repositories/external-room-message-receipts.js";
import { newId } from "../../src/db/id.js";
import { closeRedis } from "../../src/redis/index.js";
import { channelPoster } from "../../src/runtime/default.js";
import type { CodexSubscriptionStatus, CodexSubscriptionStatusProvider } from "../../src/routes/team.js";
import type { LaunchInput, SessionLogger } from "../../src/runtime/manager.js";
import { TeamChannel } from "../../src/team/channel.js";
import { TeamCoordinator } from "../../src/team/coordinator.js";
import { TelegramRoomService } from "../../src/telegram/service.js";
import { WhatsAppRoomService, type WhatsAppTransport } from "../../src/whatsapp/service.js";
import { createExternalRoomMirror, setExternalRoomMirror } from "../../src/messaging/external-room-mirror.js";

let app: FastifyInstance;
let whatsappService: WhatsAppRoomService;
const slugs: string[] = [];
const originalEnv = {
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ROOM_RECIPIENT: process.env.WHATSAPP_ROOM_RECIPIENT,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
};
const sendMessage = vi.fn(async () => ({ ok: true, messageId: "wamid.room.42" }));
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
    return { id: "whatsapp-session-" + teamLaunches.length };
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

function buildWhatsAppTestApp(service: WhatsAppRoomService): FastifyInstance {
  return buildApp({
    whatsapp: service,
    teamCoordinator: createTeamCoordinator(),
    codexSubscription,
  });
}

function restoreExternalRoomMirror(): void {
  if (!whatsappService) return;
  setExternalRoomMirror(
    createExternalRoomMirror({
      telegram: new TelegramRoomService({ apiBaseUrl: "https://telegram.test", maxChars: 3500 }),
      whatsapp: whatsappService,
      log: silentLogger,
    }),
  );
}

beforeAll(async () => {
  process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-id";
  delete process.env.WHATSAPP_ROOM_RECIPIENT;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-token";
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  const transport: WhatsAppTransport = { sendMessage };
  whatsappService = new WhatsAppRoomService(
    {
      accessToken: "wa-token",
      phoneNumberId: "phone-id",
      webhookVerifyToken: "verify-token",
      appSecret: "app-secret",
      apiBaseUrl: "https://graph.test/v20.0",
      maxChars: 3500,
    },
    transport,
  );
  app = buildWhatsAppTestApp(whatsappService);
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

function signRaw(rawBody: string): string {
  return "sha256=" + createHmac("sha256", "app-secret").update(rawBody).digest("hex");
}

function sign(payload: unknown): string {
  return signRaw(JSON.stringify(payload));
}

async function newOwner(targetApp: FastifyInstance = app): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `whatsapp-${newId()}`;
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
  name = "whatsapp-room",
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
  return { memberId: res.json().id as string, token: res.json().token as string };
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
    if (Date.now() > deadline) throw new Error("expected WhatsApp send containing " + text);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForProviderReceipt(providerConversationId: string, providerMessageId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    !(await getExternalRoomMessageReceipt({
      provider: "whatsapp",
      providerConversationId,
      providerMessageId,
    }))
  ) {
    if (Date.now() > deadline) {
      throw new Error("expected WhatsApp receipt " + providerConversationId + "/" + providerMessageId);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("WhatsApp room bridge (#1267)", () => {
  it("automatically mirrors signed-in web room messages to WhatsApp (#1424)", async () => {
    const owner = await newOwner();
    const channelId = await createChannel(owner);
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/whatsapp_room/enable",
      cookies: { rid: owner.cookie },
      payload: { recipient: "+1 (555) 333-4444" },
    });
    expect(enable.statusCode).toBe(200);

    const posted = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      cookies: { rid: owner.cookie },
      payload: { body: "web room update for WhatsApp" },
    });

    expect(posted.statusCode).toBe(201);
    expect(sendMessage).toHaveBeenCalledWith({
      accessToken: "wa-token",
      apiBaseUrl: "https://graph.test/v20.0",
      phoneNumberId: "phone-id",
      recipient: "15553334444",
      text: expect.stringContaining(`ref: wa:${channelId}:${posted.json().id}`),
    });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain("Gagan: web room update for WhatsApp");
    expect(sendMessage.mock.calls[0]?.[0].text).not.toContain("workspace:");
  });

  it("authors WhatsApp replies to agent updates as the connected human, not the agent", async () => {
    const owner = await newOwner();
    const channelId = await createChannel(owner);
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/whatsapp_room/enable",
      cookies: { rid: owner.cookie },
      payload: { recipient: "+1 (555) 777-8888" },
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
    await waitForSendContaining(`ref: wa:${channelId}:${agentPost.id}`);
    await waitForProviderReceipt("15557778888", "wamid.room.42");

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.owner.reply",
                    from: "15557778888",
                    context: { id: "wamid.room.42" },
                    text: { body: "tighten the launch angle" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const rawPayload = JSON.stringify(payload);
    const inbound = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signRaw(rawPayload),
      },
      payload: rawPayload,
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

  it("does not persist a WhatsApp room start when deployment sender config is missing", async () => {
    const misconfiguredApp = buildWhatsAppTestApp(
      new WhatsAppRoomService(
        {
          phoneNumberId: "phone-id",
          webhookVerifyToken: "verify-token",
          appSecret: "app-secret",
          apiBaseUrl: "https://graph.test/v20.0",
          maxChars: 3500,
        },
        { sendMessage },
      ),
    );
    await misconfiguredApp.ready();
    try {
      const owner = await newOwner(misconfiguredApp);
      const channelId = await createChannel(owner, "whatsapp-missing-sender", misconfiguredApp);
      const enable = await misconfiguredApp.inject({
        method: "POST",
        url: "/me/connections/whatsapp_room/enable",
        cookies: { rid: owner.cookie },
        payload: { recipient: "+1 (555) 111-2222" },
      });
      expect(enable.statusCode).toBe(200);

      const started = await misconfiguredApp.inject({
        method: "POST",
        url: `/channels/${channelId}/whatsapp/room`,
        cookies: { rid: owner.cookie },
        payload: { text: "agents, show the WhatsApp room" },
      });
      expect(started.statusCode).toBe(503);
      expect(started.json()).toMatchObject({
        status: "not_configured",
        missingEnv: ["WHATSAPP_ACCESS_TOKEN"],
      });
      expect(started.json().message).toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
      await expect(listChannelMessages(channelId)).resolves.toHaveLength(0);
    } finally {
      await misconfiguredApp.close();
    }
  });

  it("connects a configured WhatsApp room, mirrors room events, and ingests signed replies", async () => {
    const owner = await newOwner();
    const channelId = await createChannel(owner);

    const challenge = await app.inject({
      method: "GET",
      url: "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=ok-123",
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.body).toBe("ok-123");

    const missingDestination = await app.inject({
      method: "POST",
      url: "/me/connections/whatsapp_room/enable",
      cookies: { rid: owner.cookie },
    });
    expect(missingDestination.statusCode).toBe(400);

    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/whatsapp_room/enable",
      cookies: { rid: owner.cookie },
      payload: { recipient: "+1 (555) 111-2222" },
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
      text: expect.stringContaining(`ref: wa:${channelId}:${started.json().message.id}`),
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
                    context: { id: "wamid.room.42" },
                    text: {
                      body: "YES ship homepage because the draft is approved",
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
    expect(wrongSender.statusCode).toBe(400);

    const rawPayload = JSON.stringify(payload, null, 2);
    const inbound = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signRaw(rawPayload),
      },
      payload: rawPayload,
    });
    expect(inbound.statusCode).toBe(201);
    expect(inbound.json()).toMatchObject({
      status: "ingested",
      receipt: "whatsapp-provider:wamid.room.42",
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
      "YES ship homepage because the draft is approved",
    ]);

    const agent = await newAgent(owner, `agent-${newId()}`);
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { actionType: "billing.refund", payload: { paymentIntentId: "pi_whatsapp", reason: "duplicate" } },
    });
    expect(submit.statusCode).toBe(202);
    const rid = submit.json().request.id as string;
    const approvalPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551112222",
                    context: { id: "wamid.room.42" },
                    text: {
                      body: `YES approval ${rid} because reviewed in WhatsApp`,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const approvalRaw = JSON.stringify(approvalPayload);
    const approval = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signRaw(approvalRaw),
      },
      payload: approvalRaw,
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

  it("lets a first inbound WhatsApp message start the Codex marketing team room (#1423)", async () => {
    codexConnected = true;
    const owner = await newOwner();
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/whatsapp_room/enable",
      cookies: { rid: owner.cookie },
      payload: { recipient: "+1 (555) 222-3333" },
    });
    expect(enable.statusCode).toBe(200);

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.inbound.1",
                    from: "15552223333",
                    text: { body: "market ipop.ai" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const rawPayload = JSON.stringify(payload);
    const first = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signRaw(rawPayload),
      },
      payload: rawPayload,
    });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      status: "launched",
      subtaskCount: 4,
      providerReply: { status: "sent", recipient: "15552223333" },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      accessToken: "wa-token",
      apiBaseUrl: "https://graph.test/v20.0",
      phoneNumberId: "phone-id",
      recipient: "15552223333",
      text: expect.stringContaining("Scout, Quill, Echo, and Bid are starting"),
    });
    await waitForLaunches(4);
    await waitForSendContaining("started:");
    expect(teamLaunches.map((launch) => launch.harness)).toEqual(["codex", "codex", "codex", "codex"]);
    expect(new Set(teamLaunches.map((launch) => launch.teamRunId))).toEqual(new Set([first.json().teamRunId]));
    expect((await listChannelMessages(first.json().channelId)).map((m) => m.body)).toContain("market ipop.ai");
  });
});
