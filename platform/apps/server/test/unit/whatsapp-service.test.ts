import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseWhatsAppRoomReceipt,
  whatsappRoomReceipt,
  WhatsAppRoomService,
  type WhatsAppTransport,
} from "../../src/whatsapp/service.js";

describe("WhatsApp room service (#1267)", () => {
  it("formats and parses room receipts", () => {
    const text = whatsappRoomReceipt({
      workspaceId: "wid",
      channelId: "ch1",
      messageId: "msg1",
      author: "Gagan",
      text: "show the team working",
    });
    expect(text).toContain("receipt: whatsapp:ch1:msg1");
    expect(parseWhatsAppRoomReceipt("whatsapp:ch1:msg1")).toEqual({ channelId: "ch1", messageId: "msg1" });
    expect(parseWhatsAppRoomReceipt("telegram:ch1:msg1")).toBeNull();
  });

  it("fails closed until sender and webhook credentials are configured", async () => {
    const service = new WhatsAppRoomService({ apiBaseUrl: "https://graph.facebook.com/v20.0", maxChars: 10 });
    expect(service.status()).toMatchObject({
      configured: false,
      missingEnv: [
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
        "WHATSAPP_APP_SECRET",
      ],
    });
    await expect(service.send({ recipient: "15551112222", text: "hello" })).resolves.toMatchObject({
      status: "not_configured",
    });
  });

  it("verifies Meta webhook signatures and sends through the transport", async () => {
    const transport: WhatsAppTransport = {
      sendMessage: vi.fn(async () => ({ ok: true, messageId: "wamid.42" })),
    };
    const service = new WhatsAppRoomService(
      {
        accessToken: "wa-token",
        phoneNumberId: "phone-id",
        webhookVerifyToken: "verify-token",
        appSecret: "app-secret",
        apiBaseUrl: "https://graph.test/v20.0",
        maxChars: 100,
      },
      transport,
    );
    const body = JSON.stringify({ hello: "world" });
    const signature = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
    expect(service.verifySignature(body, signature)).toBe(true);
    expect(service.verifySignature(body, "sha256=bad")).toBe(false);

    await expect(service.send({ recipient: "15551112222", text: "hello" })).resolves.toEqual({
      status: "sent",
      recipient: "15551112222",
      providerMessageId: "wamid.42",
    });
    expect(transport.sendMessage).toHaveBeenCalledWith({
      accessToken: "wa-token",
      apiBaseUrl: "https://graph.test/v20.0",
      phoneNumberId: "phone-id",
      recipient: "15551112222",
      text: "hello",
    });
  });
});
