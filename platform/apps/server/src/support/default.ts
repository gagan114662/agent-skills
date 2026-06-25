import { SupportDeskService } from "./service.js";
import type { ReplyGate } from "../voice/service.js";
import { resolveSupportDeskCaps } from "./caps.js";
import { loadConfig } from "../config/loader.js";
import { EnvSecretsResolver, type SecretsResolver } from "../runtime/secrets-resolver.js";
import { dbTicketStore } from "../db/repositories/voice.js";
import { dbKbStore, dbReceiptStore } from "../db/repositories/support.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { createRequest } from "../db/repositories/approvals.js";
import { createDefaultCustomerVoiceService } from "../voice/default.js";
import type { CustomerVoiceService } from "../voice/service.js";

/**
 * Production wiring for the Support Desk (#190, ADR-0190). The dangerous seams are deliberately **OFF**:
 *
 *  - `autoApprover` is **unset** — so even with `supportDesk.autoSend` ON, an `auto_send` route degrades to
 *    a pending #13 human approval. Autonomy requires an explicit deployment to wire an approver.
 *  - `complaints` (the recurring-issue filer) is a **no-op** — so CI/default never opens a GitHub issue.
 *  - `ownerWorkspace` returns **false** — so `ownerWorkspaceOnly` (the default) blocks auto-send everywhere
 *    until a deployment supplies a real owner-workspace check.
 *
 * Inbound intake reuses the #114 voice `ingestTicket` (classify + persist). The inbound webhook secret is
 * resolved per tenant via the #25 secrets path (default name `SUPPORT_WEBHOOK_SECRET`); when unset the
 * widget/receipts routes 503 (default-OFF). The approval executor fail-closes support replies unless a
 * deployment wires a support delivery dispatcher, so approval never silently records a no-op as delivered.
 */
export const DEFAULT_SUPPORT_WEBHOOK_SECRET_NAME = "SUPPORT_WEBHOOK_SECRET";

/** The #13 gate: a reply (external.send) or refund draft (billing.refund) becomes a pending approval. */
const supportGate: ReplyGate = {
  submit: async (input) => {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: input.actionType,
      payload: input.payload,
      amount: input.amount,
      summary: input.summary,
      status: "pending", // sensitive-by-default — a human approves (auto-approve is a separate, opt-in seam)
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "support", ...input.payload } }],
    });
    return { id: req.id };
  },
};

export function createDefaultSupportDeskService(
  secrets?: SecretsResolver,
  voiceService?: CustomerVoiceService,
): SupportDeskService {
  const resolver = secrets ?? new EnvSecretsResolver();
  const voice = voiceService ?? createDefaultCustomerVoiceService(secrets);
  return new SupportDeskService({
    ingest: async (input) => {
      const { ticket, deduped } = await voice.ingestTicket(input);
      return { ticket, deduped };
    },
    tickets: dbTicketStore,
    kb: dbKbStore,
    receipts: dbReceiptStore,
    gate: supportGate,
    // autoApprover: UNSET — autonomy is opt-in per deployment (see module doc).
    // complaints: UNSET — no recurring-issue filing by default (CI never opens issues).
    // ownerWorkspace: defaults to false — ownerWorkspaceOnly blocks auto-send until a real check is wired.
    ownerMember: (workspaceId) => getWorkspaceOwnerMemberId(workspaceId),
    caps: (workspaceId) => resolveSupportDeskCaps(loadConfig(workspaceId).supportDesk),
    webhookSecret: async (workspaceId) => {
      const secretMap = await resolver.resolve(workspaceId);
      return secretMap[DEFAULT_SUPPORT_WEBHOOK_SECRET_NAME] ?? null;
    },
  });
}
