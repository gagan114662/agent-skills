import { describe, expect, it, vi } from "vitest";
import {
  parseTelegramRoomReceipt,
  telegramRoomReceipt,
  TelegramRoomService,
  type TelegramTransport,
} from "../../src/telegram/service.js";

describe("Telegram room service (#1267)", () => {
  it("formats and parses room receipts", () => {
    const text = telegramRoomReceipt({
      workspaceId: "wid",
      channelId: "ch1",
      messageId: "msg1",
      author: "Gagan",
      text: "show the team working",
    });
    expect(text).not.toContain("workspace:");
    expect(text).toContain("ref: tg:ch1:msg1");
    expect(text).toContain("Gagan: show the team working");
    expect(parseTelegramRoomReceipt("ref: tg:ch1:msg1")).toEqual({ channelId: "ch1", messageId: "msg1" });
    expect(parseTelegramRoomReceipt("receipt: telegram:ch1:msg1")).toEqual({ channelId: "ch1", messageId: "msg1" });
    expect(parseTelegramRoomReceipt("telegram:ch1:msg1")).toEqual({ channelId: "ch1", messageId: "msg1" });
    expect(parseTelegramRoomReceipt("imessage:ch1:msg1")).toBeNull();
  });

  it("fails closed until bot token and webhook secret are configured", async () => {
    const service = new TelegramRoomService({ apiBaseUrl: "https://api.telegram.org", maxChars: 10 });
    expect(service.status()).toMatchObject({
      configured: false,
      missingEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
    });
    await expect(service.send({ chatId: "123", text: "hello" })).resolves.toMatchObject({
      status: "not_configured",
    });
  });

  it("sends through the configured Telegram transport", async () => {
    const transport: TelegramTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "42" })),
    };
    const service = new TelegramRoomService(
      {
        botToken: "bot-token",
        webhookSecret: "secret",
        apiBaseUrl: "https://telegram.test",
        maxChars: 100,
      },
      transport,
    );

    await expect(service.send({ chatId: "123", text: "hello" })).resolves.toEqual({
      status: "sent",
      chatId: "123",
      providerMessageId: "42",
    });
    expect(transport.sendMessage).toHaveBeenCalledWith({
      botToken: "bot-token",
      apiBaseUrl: "https://telegram.test",
      chatId: "123",
      text: "hello",
    });
  });
});
