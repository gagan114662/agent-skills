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
          name: "whatsapp-config",
          status: "fail",
          message: expect.stringContaining("WHATSAPP_ACCESS_TOKEN"),
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
        expect.objectContaining({ name: "whatsapp-send-smoke", status: "pass" }),
      ]),
    );
  });
});
