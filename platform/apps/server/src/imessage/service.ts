import type { IMessageAdapter, IMessageRelayConfig, IMessageSendInput, IMessageSendResult, IMessageStatus } from "./types.js";

export interface IMessageRoomReceiptInput {
  workspaceId: string;
  channelId: string;
  messageId: string;
  author: string;
  text: string;
}

export function imessageRoomReceipt(input: IMessageRoomReceiptInput): string {
  return [
    "ipop iMessage room",
    "author: " + input.author,
    "workspace: " + input.workspaceId,
    "channel: " + input.channelId,
    "message: " + input.messageId,
    "receipt: imessage:" + input.channelId + ":" + input.messageId,
    "",
    input.text,
  ].join("\n");
}

export function parseIMessageRoomReceipt(receipt: unknown): { channelId: string; messageId: string } | null {
  if (typeof receipt !== "string") return null;
  const match = receipt.trim().match(/^imessage:([^:\s]+):([^:\s]+)$/);
  if (!match) return null;
  return { channelId: match[1]!, messageId: match[2]! };
}

export function imessageRoomPreflight(status: IMessageStatus): IMessageSendResult | null {
  if (!status.enabled) {
    return {
      status: "disabled",
      dryRun: status.dryRun,
      recipient: status.recipient,
      error: "iMessage relay is disabled for this workspace.",
    };
  }
  if (!status.configured) {
    return {
      status: "not_configured",
      dryRun: status.dryRun,
      recipient: status.recipient,
      error: status.requiresVerification
        ? "Verify this iMessage recipient with a successful test send before starting the room."
        : "iMessage relay is not configured for this workspace yet.",
    };
  }
  if (status.dryRun) {
    return {
      status: "dry_run",
      dryRun: true,
      recipient: status.recipient,
      error: "iMessage relay is still in dry-run mode; no real Messages room was started.",
    };
  }
  return null;
}

export class IMessageRelayService {
  constructor(
    private readonly config: IMessageRelayConfig,
    private readonly adapter: IMessageAdapter,
  ) {}

  status(): IMessageStatus {
    return this.statusFor();
  }

  statusFor(input: { recipient?: string; source?: IMessageStatus["recipientSource"]; verified?: boolean } = {}): IMessageStatus {
    const recipient = input.recipient ?? this.config.recipient;
    const source = input.source ?? (recipient ? "workspace" : "none");
    const requiresVerification = source === "member_pending" || input.verified === false;
    return {
      enabled: this.config.enabled,
      configured: Boolean(recipient) && !requiresVerification,
      dryRun: this.config.dryRun,
      recipient,
      recipientSource: source,
      requiresVerification,
      maxChars: this.config.maxChars,
    };
  }

  async send(input: IMessageSendInput): Promise<IMessageSendResult> {
    const recipient = input.recipient ?? this.config.recipient;
    if (!this.config.enabled) return { status: "disabled", dryRun: this.config.dryRun, recipient };
    if (!recipient) return { status: "not_configured", dryRun: this.config.dryRun };
    if (input.text.length > this.config.maxChars) {
      return { status: "too_long", dryRun: this.config.dryRun, recipient, error: "message too long" };
    }
    if (this.config.dryRun) return { status: "dry_run", dryRun: true, recipient };
    try {
      await this.adapter.send({ recipient, text: input.text, serviceName: input.serviceName ?? this.config.serviceName });
      return { status: "sent", dryRun: false, recipient };
    } catch (err) {
      return {
        status: "failed",
        dryRun: false,
        recipient,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
