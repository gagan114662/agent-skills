import { describe, expect, it, vi } from "vitest";
import {
  IMessageNotificationTransport,
  notificationToIMessage,
} from "../../src/imessage/notification-transport.js";
import type { NotificationRecord } from "../../src/notifications/transport.js";

const notification: NotificationRecord = {
  id: "n1",
  workspaceId: "ws1",
  recipientMemberId: "mem1",
  type: "mention",
  actorMemberId: "mem2",
  channelId: "ch1",
  messageId: "msg1",
  taskId: null,
  excerpt: "Scout found the buyer tension.",
  createdAt: "2026-06-26T00:00:00.000Z",
};

describe("iMessage notification transport", () => {
  it("formats a concise message with room context", () => {
    expect(notificationToIMessage(notification)).toContain("ipop mention");
    expect(notificationToIMessage(notification)).toContain("Scout found the buyer tension.");
    expect(notificationToIMessage(notification)).toContain("channel: ch1");
    expect(notificationToIMessage(notification)).toContain("message: msg1");
  });

  it("uses the relay service to deliver notifications", async () => {
    const send = vi.fn(async () => ({ status: "sent" as const, dryRun: false, recipient: "gagan@example.com" }));
    const transport = new IMessageNotificationTransport({ send } as never);

    await transport.deliver(notification);

    expect(send).toHaveBeenCalledWith({ text: notificationToIMessage(notification) });
  });
});
