import { describe, it, expect } from "vitest";
import {
  isNotificationType,
  shouldNotify,
  DEFAULT_PREFS,
  type NotificationPrefs,
} from "../../src/notifications/types.js";
import {
  NoopTransport,
  WebhookTransport,
  buildWebhookPayload,
  selectTransport,
  type NotificationRecord,
} from "../../src/notifications/transport.js";

const sample: NotificationRecord = {
  id: "n1",
  workspaceId: "w1",
  recipientMemberId: "m1",
  type: "mention",
  actorMemberId: "m2",
  channelId: "c1",
  messageId: "msg1",
  taskId: null,
  excerpt: "hey @you",
  createdAt: "2026-06-07T00:00:00.000Z",
};

describe("isNotificationType", () => {
  it("accepts the known notification types", () => {
    for (const t of ["mention", "dm", "reply", "assignment", "approval"]) {
      expect(isNotificationType(t)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isNotificationType("bogus")).toBe(false);
    expect(isNotificationType("")).toBe(false);
    expect(isNotificationType(null)).toBe(false);
    expect(isNotificationType(42)).toBe(false);
  });
});

describe("shouldNotify (preference gate)", () => {
  const all = ["mention", "dm", "reply", "assignment", "approval"] as const;

  it("by default delivers every type", () => {
    for (const t of all) expect(shouldNotify(t, DEFAULT_PREFS)).toBe(true);
  });

  it("muted suppresses everything, including mentions", () => {
    const prefs: NotificationPrefs = { muted: true, mentionOnly: false };
    for (const t of all) expect(shouldNotify(t, prefs)).toBe(false);
  });

  it("mentionOnly delivers only mentions, suppresses every non-mention type", () => {
    const prefs: NotificationPrefs = { muted: false, mentionOnly: true };
    expect(shouldNotify("mention", prefs)).toBe(true);
    expect(shouldNotify("dm", prefs)).toBe(false);
    expect(shouldNotify("reply", prefs)).toBe(false);
    expect(shouldNotify("assignment", prefs)).toBe(false);
    expect(shouldNotify("approval", prefs)).toBe(false);
  });

  it("muted wins over mentionOnly", () => {
    const prefs: NotificationPrefs = { muted: true, mentionOnly: true };
    expect(shouldNotify("mention", prefs)).toBe(false);
  });
});

describe("notification transport", () => {
  it("NoopTransport.deliver resolves without side effects", async () => {
    await expect(new NoopTransport().deliver(sample)).resolves.toBeUndefined();
  });

  it("buildWebhookPayload wraps the record in a stable envelope", () => {
    expect(buildWebhookPayload(sample)).toEqual({ event: "notification", notification: sample });
  });

  it("WebhookTransport POSTs the JSON payload to the configured URL via the injected fetch", async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return undefined;
    };
    const transport = new WebhookTransport("https://hooks.example/notify", fakeFetch);
    await transport.deliver(sample);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example/notify");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ event: "notification", notification: sample });
  });

  it("selectTransport returns a Noop transport when no webhook url is configured", () => {
    expect(selectTransport(undefined)).toBeInstanceOf(NoopTransport);
    expect(selectTransport("")).toBeInstanceOf(NoopTransport);
  });

  it("selectTransport returns a Webhook transport when a url is configured", () => {
    expect(selectTransport("https://hooks.example/notify")).toBeInstanceOf(WebhookTransport);
  });
});
