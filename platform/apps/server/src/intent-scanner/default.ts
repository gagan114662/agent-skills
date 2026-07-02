import { createRequest } from "../db/repositories/approvals.js";
import { INTENT_REPLY_ACTION } from "../approvals/policy.js";
import { dbIntentScannerStore } from "../db/repositories/intent-scanner.js";
import { EmptyIntentScannerProvider } from "./provider.js";
import {
  approvalSummary,
  intentApprovalPayload,
  IntentScannerService,
  type IntentApprovalGate,
} from "./service.js";

const approvalGate: IntentApprovalGate = {
  async submit(input) {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: INTENT_REPLY_ACTION,
      payload: intentApprovalPayload(input.lead),
      amount: null,
      summary: approvalSummary(input.lead),
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "intent_scanner", leadId: input.lead.id } }],
    });
    return { id: req.id };
  },
};

export function createDefaultIntentScannerService(): IntentScannerService {
  return new IntentScannerService({
    store: dbIntentScannerStore,
    provider: new EmptyIntentScannerProvider(),
    approvals: approvalGate,
  });
}
