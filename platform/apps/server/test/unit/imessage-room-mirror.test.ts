import { describe, expect, it, vi } from "vitest";
import type { IMessageRelayJob } from "../../src/db/repositories/imessage.js";
import type { Message } from "../../src/db/repositories/messages.js";
import { createIMessageRoomMirror } from "../../src/messaging/imessage-room-mirror.js";

function message(input: Partial<Message> = {}): Message {
  return {
    id: input.id ?? "m2",
    channelId: input.channelId ?? "c1",
    authorMemberId: input.authorMemberId ?? "agent-1",
    parentMessageId: input.parentMessageId ?? "m1",
    alsoSentToChannel: input.alsoSentToChannel ?? false,
    body: input.body ?? "Drafting the launch angle",
  };
}

function roomJob(input: Partial<IMessageRelayJob> = {}): IMessageRelayJob {
  return {
    id: input.id ?? "job-room",
    workspaceId: input.workspaceId ?? "w1",
    memberId: input.memberId ?? "owner-1",
    channelId: input.channelId ?? "c1",
    messageId: input.messageId ?? "m1",
    purpose: input.purpose ?? "room",
    recipient: input.recipient ?? "+15551112222",
    serviceName: input.serviceName ?? "E:owner@example.com",
    body: input.body ?? "room start",
    receipt: input.receipt ?? "imessage:c1:m1",
    status: input.status ?? "sent",
    lockedBy: input.lockedBy ?? null,
    lockedUntil: input.lockedUntil ?? null,
    sentAt: input.sentAt ?? new Date(),
    failedAt: input.failedAt ?? null,
    error: input.error ?? null,
    createdAt: input.createdAt ?? new Date(),
    updatedAt: input.updatedAt ?? new Date(),
  };
}

describe("iMessage room mirror (#1283)", () => {
  it("queues agent posts into an existing sent iMessage room", async () => {
    const enqueueJob = vi.fn(async () => roomJob({ id: "job-notify", purpose: "notification" }));
    const mirror = createIMessageRoomMirror({
      getRoomJob: vi.fn(async () => roomJob()),
      getJobForMessage: vi.fn(async () => undefined),
      enqueueJob,
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Quill" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message(),
      source: "agent_post",
    });

    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        memberId: "owner-1",
        channelId: "c1",
        messageId: "m2",
        purpose: "notification",
        recipient: "+15551112222",
        serviceName: "E:owner@example.com",
        receipt: "imessage:c1:m2",
        body: expect.stringMatching(/author: Quill[\s\S]*Drafting the launch angle/),
      }),
    );
  });

  it("does not queue human echoes, unstarted rooms, or duplicate notifications", async () => {
    const enqueueJob = vi.fn(async () => roomJob({ id: "job-notify", purpose: "notification" }));
    const mirror = createIMessageRoomMirror({
      getRoomJob: vi.fn(async () => undefined),
      getJobForMessage: vi.fn(async () => undefined),
      enqueueJob,
    });

    await mirror.mirror({ workspaceId: "w1", channelId: "c1", message: message(), source: "room_message" });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ alsoSentToChannel: true }),
      source: "agent_post",
    });
    await mirror.mirror({ workspaceId: "w1", channelId: "c1", message: message(), source: "agent_post" });
    expect(enqueueJob).not.toHaveBeenCalled();

    const duplicateMirror = createIMessageRoomMirror({
      getRoomJob: vi.fn(async () => roomJob()),
      getJobForMessage: vi.fn(async () => roomJob({ id: "existing", purpose: "notification" })),
      enqueueJob,
    });
    await duplicateMirror.mirror({ workspaceId: "w1", channelId: "c1", message: message(), source: "agent_post" });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("does not queue raw tool-command chatter into the native iMessage room by default (#1496)", async () => {
    const enqueueJob = vi.fn(async () => roomJob({ id: "job-notify", purpose: "notification" }));
    const mirror = createIMessageRoomMirror({
      getRoomJob: vi.fn(async () => roomJob()),
      getJobForMessage: vi.fn(async () => undefined),
      enqueueJob,
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Quill" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ body: "\u{1f527} /bin/sh -lc 'ls -la'" }),
      source: "agent_post",
    });

    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
