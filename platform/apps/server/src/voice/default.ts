import { CustomerVoiceService, type ReplyGate } from "./service.js";
import { resolveVoiceCaps } from "./caps.js";
import { loadConfig } from "../config/loader.js";
import { EnvSecretsResolver, type SecretsResolver } from "../runtime/secrets-resolver.js";
import { dbTicketStore, dbInsightStore } from "../db/repositories/voice.js";
import { createRequest } from "../db/repositories/approvals.js";
import { getIdea } from "../db/repositories/venture.js";

/**
 * Production wiring for the Customer Voice Loop (#114, ADR-0114). The ticket inbox + insight log are
 * backed by the workspace-scoped `voice` repo; the reply gate creates a **pending** #13 approval request
 * (`external.send` is sensitive-by-default, ADR-0013) so a human approves + sends. No change to
 * `approvals/policy.ts` or the executor. The inbound webhook secret is resolved per tenant via the #25
 * secrets path (default name `VOICE_WEBHOOK_SECRET`); when unset the webhook route 503s (default-OFF).
 * No triage agent is wired by default — the safe default is "the ticket lands open and needs a human".
 */
export const DEFAULT_VOICE_WEBHOOK_SECRET_NAME = "VOICE_WEBHOOK_SECRET";

/** The #13 gate: an outbound reply becomes a pending approval the owner reviews in #104. */
const replyGate: ReplyGate = {
  submit: async (input) => {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: input.actionType,
      payload: input.payload,
      amount: input.amount,
      summary: input.summary,
      status: "pending", // external.send is sensitive-by-default — always a human gate
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "voice", ...input.payload } }],
    });
    return { id: req.id };
  },
};

export function createDefaultCustomerVoiceService(secrets?: SecretsResolver): CustomerVoiceService {
  const resolver = secrets ?? new EnvSecretsResolver();
  return new CustomerVoiceService({
    tickets: dbTicketStore,
    insights: dbInsightStore,
    gate: replyGate,
    // #19 IDOR: a ticket/insight may only attach to a venture idea in the same workspace.
    ventures: { exists: async (wid, ideaId) => (await getIdea(wid, ideaId)) !== undefined },
    caps: (workspaceId) => resolveVoiceCaps(loadConfig(workspaceId).voice),
    webhookSecret: async (workspaceId) => {
      const secretMap = await resolver.resolve(workspaceId);
      return secretMap[DEFAULT_VOICE_WEBHOOK_SECRET_NAME] ?? null;
    },
  });
}
