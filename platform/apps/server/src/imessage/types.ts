export interface IMessageRelayConfig {
  enabled: boolean;
  recipient?: string;
  serviceName?: string;
  dryRun: boolean;
  maxChars: number;
}

export interface IMessageSendInput {
  text: string;
  recipient?: string;
  serviceName?: string;
}

export type IMessageSendStatus = "sent" | "queued" | "dry_run" | "disabled" | "not_configured" | "too_long" | "failed";

export interface IMessageSendResult {
  status: IMessageSendStatus;
  recipient?: string;
  dryRun: boolean;
  error?: string;
  jobId?: string;
}

export interface IMessageStatus {
  enabled: boolean;
  configured: boolean;
  dryRun: boolean;
  recipient?: string;
  recipientSource?: "member_verified" | "member_pending" | "workspace" | "none";
  requiresVerification?: boolean;
  maxChars: number;
}

export interface IMessageAdapter {
  send(input: { recipient: string; text: string; serviceName?: string }): Promise<void>;
}
