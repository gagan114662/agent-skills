import { describe, expect, it, vi } from "vitest";
import {
  parseExternalRoomDoctorConfig,
  runExternalRoomDoctor,
} from "../../src/messaging/external-room-doctor-cli.js";
import { TelegramRoomService, type TelegramTransport } from "../../src/telegram/service.js";
import { WhatsAppRoomService, type WhatsAppTransport } from "../../src/whatsapp/service.js";

function jsonResponse(payload: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("external room doctor CLI (#1267)", () => {
  it("audits production secret presence without requiring plaintext local provider credentials (#1501)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const value = String(url);
      if (value.endsWith("/version")) return jsonResponse({ version: "abc123" });
      if (value.endsWith("/readyz")) {
        return jsonResponse({
          status: "ready",
          db: "up",
          redis: "up",
          loops: { status: "ready", disabledCritical: [] },
        });
      }
      return jsonResponse({ error: "unexpected" }, { status: 404 });
    });
    const config = parseExternalRoomDoctorConfig({ env: {}, argv: ["--production"] });

    const checks = await runExternalRoomDoctor(config, {
      fetchImpl,
      listProductionSecrets: vi.fn(async () => [
        { name: "TELEGRAM_BOT_TOKEN", status: "Deployed" },
        { name: "TELEGRAM_WEBHOOK_SECRET", status: "Deployed" },
      ]),
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "telegram-production-secrets",
          status: "pass",
          message: expect.stringContaining("present in production but not locally testable"),
        }),
        expect.objectContaining({
          name: "whatsapp-production-secrets",
          status: "fail",
          message: expect.stringContaining("WHATSAPP_ACCESS_TOKEN"),
        }),
        expect.objectContaining({
          name: "production-send-smoke",
          status: "warn",
          message: expect.stringContaining("--send-smoke"),
        }),
        expect.objectContaining({
          name: "production-version",
          status: "pass",
          message: expect.stringContaining("abc123"),
        }),
        expect.objectContaining({
          name: "production-readyz",
          status: "pass",
          message: expect.stringContaining("db=up"),
        }),
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledWith("https://api.ipop.ai/version", undefined);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.ipop.ai/readyz", undefined);
    expect(checks.find((check) => check.name === "telegram-config")).toBeUndefined();
  });

  it("scopes production audit to requested providers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/version")
        ? jsonResponse({ version: "abc123" })
        : jsonResponse({
            status: "ready",
            db: "up",
            redis: "up",
            loops: { status: "ready" },
          }),
    );
    const config = parseExternalRoomDoctorConfig({
      env: {},
      argv: ["--production", "--provider", "telegram"],
    });

    const checks = await runExternalRoomDoctor(config, {
      fetchImpl,
      listProductionSecrets: vi.fn(async () => [
        { name: "TELEGRAM_BOT_TOKEN", status: "Deployed" },
        { name: "TELEGRAM_WEBHOOK_SECRET", status: "Deployed" },
      ]),
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-production-secrets", status: "pass" }),
        expect.objectContaining({ name: "production-version", status: "pass" }),
        expect.objectContaining({ name: "production-readyz", status: "pass" }),
      ]),
    );
    expect(checks.find((check) => check.name === "whatsapp-production-secrets")).toBeUndefined();
  });

  it("reports missing Telegram and WhatsApp production config without making provider calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const config = parseExternalRoomDoctorConfig({ env: {}, argv: [] });

    const checks = await runExternalRoomDoctor(config, { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "telegram-config",
          status: "fail",
          message: expect.stringContaining("TELEGRAM_BOT_TOKEN"),
        }),
        expect.objectContaining({
          name: "telegram-config",
          message: expect.stringContaining("fly secrets set --app reload-api TELEGRAM_BOT_TOKEN=<bot-token>"),
        }),
        expect.objectContaining({
          name: "telegram-config",
          message: expect.stringContaining("https://api.ipop.ai/telegram/webhook"),
        }),
        expect.objectContaining({
          name: "whatsapp-config",
          status: "fail",
          message: expect.stringContaining("WHATSAPP_ACCESS_TOKEN"),
        }),
        expect.objectContaining({
          name: "whatsapp-config",
          message: expect.stringContaining("fly secrets set --app reload-api WHATSAPP_ACCESS_TOKEN=<access-token>"),
        }),
        expect.objectContaining({
          name: "whatsapp-config",
          message: expect.stringContaining("https://api.ipop.ai/whatsapp/webhook"),
        }),
      ]),
    );
  });

  it("proves provider identity and skips sends unless --send-smoke is set", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const value = String(url);
      if (value.includes("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 123, username: "ipop_room_bot" } });
      }
      if (value.includes("/phone-id")) {
        return jsonResponse({
          id: "phone-id",
          display_phone_number: "+1 555 111 2222",
          verified_name: "ipop",
        });
      }
      return jsonResponse({ error: { message: "unexpected" } }, { status: 404 });
    });
    const config = parseExternalRoomDoctorConfig({
      argv: [],
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        TELEGRAM_ROOM_CHAT_ID: "123",
        TELEGRAM_WEBHOOK_SECRET: "telegram-webhook",
        WHATSAPP_ACCESS_TOKEN: "whatsapp-secret",
        WHATSAPP_PHONE_NUMBER_ID: "phone-id",
        WHATSAPP_ROOM_RECIPIENT: "15551112222",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
        WHATSAPP_APP_SECRET: "app-secret",
      },
    });

    const checks = await runExternalRoomDoctor(config, { fetchImpl });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-config", status: "pass" }),
        expect.objectContaining({
          name: "telegram-identity",
          status: "pass",
          message: expect.stringContaining("@ipop_room_bot"),
        }),
        expect.objectContaining({ name: "telegram-send-smoke", status: "warn" }),
        expect.objectContaining({ name: "whatsapp-config", status: "pass" }),
        expect.objectContaining({
          name: "whatsapp-sender",
          status: "pass",
          message: expect.stringContaining("ipop"),
        }),
        expect.objectContaining({ name: "whatsapp-signature", status: "pass" }),
        expect.objectContaining({ name: "whatsapp-send-smoke", status: "warn" }),
      ]),
    );
  });

  it("sends explicit smoke messages only when requested", async () => {
    const telegramTransport: TelegramTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "tg-42" })),
    };
    const whatsAppTransport: WhatsAppTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "wamid.42" })),
    };
    const config = parseExternalRoomDoctorConfig({
      argv: ["--send-smoke", "--text", "doctor smoke"],
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        TELEGRAM_ROOM_CHAT_ID: "123",
        TELEGRAM_WEBHOOK_SECRET: "telegram-webhook",
        WHATSAPP_ACCESS_TOKEN: "whatsapp-secret",
        WHATSAPP_PHONE_NUMBER_ID: "phone-id",
        WHATSAPP_ROOM_RECIPIENT: "15551112222",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
        WHATSAPP_APP_SECRET: "app-secret",
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/getMe")
        ? jsonResponse({ ok: true, result: { id: 123 } })
        : jsonResponse({ id: "phone-id" }),
    );

    const checks = await runExternalRoomDoctor(config, {
      fetchImpl,
      telegramService: new TelegramRoomService(config.telegram, telegramTransport),
      whatsappService: new WhatsAppRoomService(config.whatsapp, whatsAppTransport),
    });

    expect(telegramTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "123", text: "doctor smoke" }),
    );
    expect(whatsAppTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "15551112222", text: "doctor smoke" }),
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-send-smoke", status: "pass" }),
        expect.objectContaining({
          name: "telegram-room-receipt",
          status: "warn",
          message: expect.stringContaining("--workspace-id, --channel-id, and --message-id"),
        }),
        expect.objectContaining({ name: "whatsapp-send-smoke", status: "pass" }),
        expect.objectContaining({
          name: "whatsapp-room-receipt",
          status: "warn",
          message: expect.stringContaining("--workspace-id, --channel-id, and --message-id"),
        }),
      ]),
    );
  });

  it("sends smoke messages to workspace-connected destinations before falling back to deployment env", async () => {
    const telegramTransport: TelegramTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "tg-workspace" })),
    };
    const whatsAppTransport: WhatsAppTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "wamid.workspace" })),
    };
    const resolveServiceSecrets = vi.fn(async (_workspaceId: string, serviceKey: string) => {
      if (serviceKey === "telegram_room") return { TELEGRAM_CHAT_ID: "-1009876543210" };
      if (serviceKey === "whatsapp_room") return { WHATSAPP_RECIPIENT: "15559990000" };
      return {};
    });
    const config = parseExternalRoomDoctorConfig({
      argv: ["--send-smoke", "--workspace-id", "workspace-live", "--text", "workspace smoke"],
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        TELEGRAM_WEBHOOK_SECRET: "telegram-webhook",
        WHATSAPP_ACCESS_TOKEN: "whatsapp-secret",
        WHATSAPP_PHONE_NUMBER_ID: "phone-id",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
        WHATSAPP_APP_SECRET: "app-secret",
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/getMe")
        ? jsonResponse({ ok: true, result: { id: 123 } })
        : jsonResponse({ id: "phone-id" }),
    );

    const checks = await runExternalRoomDoctor(config, {
      fetchImpl,
      telegramService: new TelegramRoomService(config.telegram, telegramTransport),
      whatsappService: new WhatsAppRoomService(config.whatsapp, whatsAppTransport),
      resolveServiceSecrets,
    });

    expect(resolveServiceSecrets).toHaveBeenCalledWith("workspace-live", "telegram_room");
    expect(resolveServiceSecrets).toHaveBeenCalledWith("workspace-live", "whatsapp_room");
    expect(telegramTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "-1009876543210", text: "workspace smoke" }),
    );
    expect(whatsAppTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "15559990000", text: "workspace smoke" }),
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-send-smoke", status: "pass" }),
        expect.objectContaining({ name: "whatsapp-send-smoke", status: "pass" }),
      ]),
    );
  });

  it("reports an actionable gap when a smoke send has no workspace destination", async () => {
    const config = parseExternalRoomDoctorConfig({
      argv: ["--send-smoke", "--workspace-id", "workspace-missing"],
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        TELEGRAM_WEBHOOK_SECRET: "telegram-webhook",
        WHATSAPP_ACCESS_TOKEN: "whatsapp-secret",
        WHATSAPP_PHONE_NUMBER_ID: "phone-id",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
        WHATSAPP_APP_SECRET: "app-secret",
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/getMe")
        ? jsonResponse({ ok: true, result: { id: 123 } })
        : jsonResponse({ id: "phone-id" }),
    );

    const checks = await runExternalRoomDoctor(config, {
      fetchImpl,
      resolveServiceSecrets: vi.fn(async () => ({})),
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "telegram-send-smoke",
          status: "fail",
          message: expect.stringContaining("connect telegram_room with TELEGRAM_CHAT_ID"),
        }),
        expect.objectContaining({
          name: "whatsapp-send-smoke",
          status: "fail",
          message: expect.stringContaining("connect whatsapp_room with WHATSAPP_RECIPIENT"),
        }),
      ]),
    );
  });

  it("records room message receipts for explicit correlated smoke sends", async () => {
    const telegramTransport: TelegramTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "tg-77" })),
    };
    const whatsAppTransport: WhatsAppTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "wamid.77" })),
    };
    const recordExternalRoomMessageReceipt = vi.fn(async () => undefined);
    const config = parseExternalRoomDoctorConfig({
      argv: [
        "--send-smoke",
        "--text",
        "doctor correlated smoke",
        "--workspace-id",
        "00000000-0000-4000-8000-000000000001",
        "--channel-id",
        "00000000-0000-4000-8000-0000000000c1",
        "--message-id",
        "00000000-0000-4000-8000-0000000000d1",
      ],
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        TELEGRAM_ROOM_CHAT_ID: "123",
        TELEGRAM_WEBHOOK_SECRET: "telegram-webhook",
        WHATSAPP_ACCESS_TOKEN: "whatsapp-secret",
        WHATSAPP_PHONE_NUMBER_ID: "phone-id",
        WHATSAPP_ROOM_RECIPIENT: "15551112222",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
        WHATSAPP_APP_SECRET: "app-secret",
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/getMe")
        ? jsonResponse({ ok: true, result: { id: 123 } })
        : jsonResponse({ id: "phone-id" }),
    );

    const checks = await runExternalRoomDoctor(config, {
      fetchImpl,
      telegramService: new TelegramRoomService(config.telegram, telegramTransport),
      whatsappService: new WhatsAppRoomService(config.whatsapp, whatsAppTransport),
      recordExternalRoomMessageReceipt,
      resolveServiceSecrets: vi.fn(async () => ({})),
    });

    expect(recordExternalRoomMessageReceipt).toHaveBeenCalledTimes(2);
    expect(recordExternalRoomMessageReceipt).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-0000000000c1",
      messageId: "00000000-0000-4000-8000-0000000000d1",
      provider: "telegram",
      providerConversationId: "123",
      providerMessageId: "tg-77",
    });
    expect(recordExternalRoomMessageReceipt).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-0000000000c1",
      messageId: "00000000-0000-4000-8000-0000000000d1",
      provider: "whatsapp",
      providerConversationId: "15551112222",
      providerMessageId: "wamid.77",
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "telegram-room-receipt",
          status: "pass",
          message: expect.stringContaining("tg-77"),
        }),
        expect.objectContaining({
          name: "whatsapp-room-receipt",
          status: "pass",
          message: expect.stringContaining("wamid.77"),
        }),
      ]),
    );
  });
});
