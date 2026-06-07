/**
 * Pluggable external transport for notifications (issue #8). Decouples *creating* an in-app
 * notification from *forwarding* it off-platform. The default is a no-op (tests/CI need no
 * external endpoint); a webhook adapter is provided as the worked example. Delivery is
 * best-effort — the notify service calls it fire-and-forget and never lets a transport failure
 * fail the in-app notification or the REST write (ADR-0008).
 */
import type { NotificationType } from "./types.js";

/** The durable notification handed to a transport (mirrors the persisted row + WS payload). */
export interface NotificationRecord {
  id: string;
  workspaceId: string;
  recipientMemberId: string;
  type: NotificationType;
  actorMemberId: string | null;
  channelId: string | null;
  messageId: string | null;
  taskId: string | null;
  excerpt: string | null;
  createdAt: string;
}

export interface NotificationTransport {
  deliver(notification: NotificationRecord): Promise<void>;
}

/** Default transport: forwards nowhere. */
export class NoopTransport implements NotificationTransport {
  async deliver(): Promise<void> {
    /* intentionally does nothing */
  }
}

/** The stable JSON envelope POSTed by the webhook transport (and consumed by an external system). */
export interface WebhookPayload {
  event: "notification";
  notification: NotificationRecord;
}

export function buildWebhookPayload(notification: NotificationRecord): WebhookPayload {
  return { event: "notification", notification };
}

/** Minimal shape of `fetch` we depend on — injectable so the transport is unit-testable offline. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<unknown>;

/** Forwards each notification as a JSON POST to a configured URL. */
export class WebhookTransport implements NotificationTransport {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async deliver(notification: NotificationRecord): Promise<void> {
    await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildWebhookPayload(notification)),
    });
  }
}

/** Pick the transport for a deployment: webhook when a URL is configured, else no-op. */
export function selectTransport(webhookUrl?: string): NotificationTransport {
  return webhookUrl ? new WebhookTransport(webhookUrl) : new NoopTransport();
}
