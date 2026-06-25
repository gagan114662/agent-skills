import { loadConfig } from "../config/loader.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { getReachContactEmail } from "../db/repositories/reach.js";
import { PostmarkEspProvider } from "../email/postmark-provider.js";
import { dbSuppressionStore } from "../db/repositories/acquisition.js";
import { createEmailChannel, dryRunEspSender, type EspSender } from "../reach/channels/email.js";
import type { OutreachMessageRecord } from "./types.js";
import type { ReachMessage } from "../reach/types.js";
import { resolveOutreachCaps } from "./caps.js";

const POSTMARK_SERVICE_KEY = "postmark";
const POSTMARK_TOKEN_KEY = "POSTMARK_SERVER_TOKEN";
const POSTMARK_FROM_KEYS = ["POSTMARK_FROM", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER"] as const;
const TWILIO_SERVICE_KEY = "twilio";
const TWILIO_ACCOUNT_SID_KEY = "TWILIO_ACCOUNT_SID";
const TWILIO_AUTH_TOKEN_KEY = "TWILIO_AUTH_TOKEN";
const TWILIO_FROM_KEYS = ["TWILIO_FROM", "TWILIO_FROM_NUMBER", "TWILIO_MESSAGING_SERVICE_SID"] as const;

export interface OutreachSendResult {
  provider: string;
  externalId: string;
  detail: string;
}

export interface OutreachSendDispatcher {
  dispatch(workspaceId: string, message: OutreachMessageRecord): Promise<OutreachSendResult>;
}

export interface SmsSendInput {
  to: string;
  body: string;
  recipientRef: string;
}

export interface SmsSender {
  kind: string;
  send(input: SmsSendInput): Promise<OutreachSendResult>;
}

function firstSecret(secrets: Record<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = secrets[key]?.trim();
    if (value) return value;
  }
  return "";
}

function emailFromRef(ref: string): string | null {
  if (!ref.startsWith("email:")) return null;
  const value = ref.slice("email:".length).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function phoneFromRef(ref: string): string | null {
  if (!ref.startsWith("sms:")) return null;
  const value = ref.slice("sms:".length).trim();
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

function deterministicId(prefix: string, value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${prefix}_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

async function resolveRecipientEmail(workspaceId: string, recipientRef: string): Promise<string | null> {
  return emailFromRef(recipientRef) ?? getReachContactEmail(workspaceId, recipientRef);
}

async function resolveOutreachSender(workspaceId: string): Promise<EspSender> {
  const caps = resolveOutreachCaps(loadConfig(workspaceId).outreach);
  if (caps.sendProvider === "dryrun") return dryRunEspSender;
  if (caps.sendProvider !== "postmark") {
    throw new Error(`unsupported outreach send provider: ${caps.sendProvider}`);
  }
  const secrets = await resolveServiceSecrets(workspaceId, POSTMARK_SERVICE_KEY);
  const serverToken = secrets[POSTMARK_TOKEN_KEY]?.trim() ?? "";
  const from = firstSecret(secrets, POSTMARK_FROM_KEYS);
  if (!serverToken || !from) {
    throw new Error("postmark credentials missing for outreach send");
  }
  return new PostmarkEspProvider({ serverToken, from });
}

export const dryRunSmsSender: SmsSender = {
  kind: "dryrun",
  async send(input) {
    return {
      provider: "dryrun",
      externalId: deterministicId("dry_sms", `${input.recipientRef}\n${input.body}`),
      detail: "dry-run SMS recorded; no network call made",
    };
  },
};

export interface TwilioTransport {
  send(input: { accountSid: string; authToken: string; from: string; to: string; body: string }): Promise<{ sid: string }>;
}

const fetchTwilioTransport: TwilioTransport = {
  async send(input) {
    const form = new URLSearchParams({ From: input.from, To: input.to, Body: input.body });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
    );
    const data = (await res.json().catch(() => ({}))) as { sid?: unknown; message?: unknown };
    if (!res.ok || typeof data.sid !== "string") {
      const message = typeof data.message === "string" ? data.message : `Twilio returned ${res.status}`;
      throw new Error(message);
    }
    return { sid: data.sid };
  },
};

export class TwilioSmsSender implements SmsSender {
  readonly kind = "twilio";

  constructor(
    private readonly cfg: { accountSid: string; authToken: string; from: string },
    private readonly transport: TwilioTransport = fetchTwilioTransport,
  ) {}

  async send(input: SmsSendInput): Promise<OutreachSendResult> {
    const sent = await this.transport.send({
      accountSid: this.cfg.accountSid,
      authToken: this.cfg.authToken,
      from: this.cfg.from,
      to: input.to,
      body: input.body,
    });
    return { provider: this.kind, externalId: sent.sid, detail: "SMS sent via Twilio" };
  }
}

async function resolveOutreachSmsSender(workspaceId: string): Promise<SmsSender> {
  const caps = resolveOutreachCaps(loadConfig(workspaceId).outreach);
  if (caps.sendProvider === "dryrun") return dryRunSmsSender;
  if (caps.sendProvider !== "twilio") {
    throw new Error(`unsupported outreach SMS provider: ${caps.sendProvider}`);
  }
  const secrets = await resolveServiceSecrets(workspaceId, TWILIO_SERVICE_KEY);
  const accountSid = secrets[TWILIO_ACCOUNT_SID_KEY]?.trim() ?? "";
  const authToken = secrets[TWILIO_AUTH_TOKEN_KEY]?.trim() ?? "";
  const from = firstSecret(secrets, TWILIO_FROM_KEYS);
  if (!accountSid || !authToken || !from) {
    throw new Error("twilio credentials missing for outreach SMS send");
  }
  return new TwilioSmsSender({ accountSid, authToken, from });
}

export function createDefaultOutreachSendDispatcher(): OutreachSendDispatcher {
  return {
    async dispatch(workspaceId, message): Promise<OutreachSendResult> {
      if (message.channel === "sms") {
        const sender = await resolveOutreachSmsSender(workspaceId);
        const to = phoneFromRef(message.recipientRef);
        if (sender.kind !== "dryrun" && !to) {
          throw new Error("outreach recipient SMS number could not be resolved");
        }
        return sender.send({
          to: to ?? message.recipientRef,
          body: message.body,
          recipientRef: message.recipientRef,
        });
      }
      if (message.channel !== "email") {
        throw new Error(`no live outreach sender for ${message.channel}`);
      }
      const toAddress = await resolveRecipientEmail(workspaceId, message.recipientRef);
      if (!toAddress) throw new Error("outreach recipient email could not be resolved");

      const cfg = loadConfig(workspaceId);
      const footerInfo = {
        brandName: cfg.reach.brandName,
        postalAddress: cfg.reach.postalAddress,
        unsubscribeUrl: cfg.reach.unsubscribeUrl,
      };
      const sender = await resolveOutreachSender(workspaceId);
      const channel = createEmailChannel({ sender });
      const reachMessage: ReachMessage = {
        contactKey: message.recipientRef,
        channel: "email",
        toAddress,
        recipientLabel: message.recipientLabel,
        subject: message.subject,
        body: message.body,
        variant: "pain",
        signalKind: null,
      };
      const suppressed = await dbSuppressionStore.loadSuppressed(workspaceId);
      const outcome = await channel.send(reachMessage, { workspaceId, suppressed, footerInfo });
      if (outcome.status !== "sent" || !outcome.externalId) {
        throw new Error(outcome.detail || `outreach send ${outcome.status}`);
      }
      return { provider: sender.kind, externalId: outcome.externalId, detail: outcome.detail };
    },
  };
}
