import type { IMessageAdapter, IMessageRelayConfig, IMessageSendInput, IMessageSendResult, IMessageStatus } from "./types.js";

export class IMessageRelayService {
  constructor(
    private readonly config: IMessageRelayConfig,
    private readonly adapter: IMessageAdapter,
  ) {}

  status(): IMessageStatus {
    return {
      enabled: this.config.enabled,
      configured: Boolean(this.config.recipient),
      dryRun: this.config.dryRun,
      recipient: this.config.recipient,
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
      await this.adapter.send({ recipient, text: input.text, serviceName: this.config.serviceName });
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
