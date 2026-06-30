import type { FastifyBaseLogger } from "fastify";
import {
  enqueueIMessageRelayJob,
  getIMessageRelayJobForMessage,
  getLatestSentIMessageRoomRelayJobForChannel,
} from "../db/repositories/imessage.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import type { Message } from "../db/repositories/messages.js";
import { imessageRoomReceipt } from "../imessage/service.js";
import {
  formatExternalRoomEvent,
  shouldMirrorExternalRoomEvent,
  type ExternalRoomMirrorSource,
} from "./external-room-mirror.js";

export interface IMessageRoomMirrorInput {
  workspaceId: string;
  channelId: string;
  message: Message;
  author?: string;
  source: ExternalRoomMirrorSource;
}

export interface IMessageRoomMirror {
  mirror(input: IMessageRoomMirrorInput): Promise<void>;
}

interface MirrorLogger {
  error(obj: unknown, msg?: string): void;
}

interface IMessageRoomMirrorDeps {
  log?: MirrorLogger;
  getRoomJob?: typeof getLatestSentIMessageRoomRelayJobForChannel;
  getJobForMessage?: typeof getIMessageRelayJobForMessage;
  enqueueJob?: typeof enqueueIMessageRelayJob;
  getMember?: typeof getWorkspaceMember;
}

async function safeAuthor(input: {
  workspaceId: string;
  message: Message;
  author?: string;
  getMember: typeof getWorkspaceMember;
}): Promise<string> {
  if (input.author?.trim()) return input.author.trim();
  const member = await input.getMember(input.message.authorMemberId, input.workspaceId);
  return member?.displayName ?? "ipop";
}

export function createIMessageRoomMirror(deps: IMessageRoomMirrorDeps = {}): IMessageRoomMirror {
  const getRoomJob = deps.getRoomJob ?? getLatestSentIMessageRoomRelayJobForChannel;
  const getJobForMessage = deps.getJobForMessage ?? getIMessageRelayJobForMessage;
  const enqueueJob = deps.enqueueJob ?? enqueueIMessageRelayJob;
  const getMember = deps.getMember ?? getWorkspaceMember;

  return {
    async mirror(input) {
      if (input.message.alsoSentToChannel || input.source !== "agent_post") return;
      if (!shouldMirrorExternalRoomEvent({ body: input.message.body, source: input.source })) return;
      const roomJob = await getRoomJob({ workspaceId: input.workspaceId, channelId: input.channelId });
      if (!roomJob || !roomJob.memberId) return;
      const existing = await getJobForMessage({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.message.id,
        purpose: "notification",
      });
      if (existing) return;

      const author = await safeAuthor({ ...input, getMember });
      const event = formatExternalRoomEvent({ body: input.message.body, source: input.source });
      await enqueueJob({
        workspaceId: input.workspaceId,
        memberId: roomJob.memberId,
        channelId: input.channelId,
        messageId: input.message.id,
        purpose: "notification",
        recipient: roomJob.recipient,
        serviceName: roomJob.serviceName,
        body: imessageRoomReceipt({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          messageId: input.message.id,
          author,
          text: event.text,
        }),
        receipt: "imessage:" + input.channelId + ":" + input.message.id,
      });
    },
  };
}

let imessageRoomMirror: IMessageRoomMirror | undefined;

export function setIMessageRoomMirror(mirror: IMessageRoomMirror | undefined): void {
  imessageRoomMirror = mirror;
}

export async function mirrorIMessageRoomPost(
  log: FastifyBaseLogger | undefined,
  input: IMessageRoomMirrorInput,
): Promise<void> {
  if (!imessageRoomMirror) return;
  try {
    await imessageRoomMirror.mirror(input);
  } catch (err) {
    (log ?? undefined)?.error(
      {
        err,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.message.id,
        retryable: true,
      },
      "iMessage room mirror crashed",
    );
  }
}
