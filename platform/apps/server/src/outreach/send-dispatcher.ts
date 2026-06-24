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

export interface OutreachSendResult {
  provider: string;
  externalId: string;
  detail: string;
}

export interface OutreachSendDispatcher {
  dispatch(workspaceId: string, message: OutreachMessageRecord): Promise<OutreachSendResult>;
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

export function createDefaultOutreachSendDispatcher(): OutreachSendDispatcher {
  return {
    async dispatch(workspaceId, message): Promise<OutreachSendResult> {
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
