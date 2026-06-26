import type { NotificationRecord, NotificationTransport } from "../notifications/transport.js";
import type { IMessageRelayService } from "./service.js";

export function notificationToIMessage(notification: NotificationRecord): string {
  const lines = [
    "ipop " + notification.type,
    notification.excerpt ? notification.excerpt : null,
    notification.channelId ? "channel: " + notification.channelId : null,
    notification.messageId ? "message: " + notification.messageId : null,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export class IMessageNotificationTransport implements NotificationTransport {
  constructor(private readonly service: IMessageRelayService) {}

  async deliver(notification: NotificationRecord): Promise<void> {
    const result = await this.service.send({ text: notificationToIMessage(notification) });
    if (result.status === "failed") throw new Error(result.error ?? "iMessage delivery failed");
  }
}
