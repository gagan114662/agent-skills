import { LegalService, type LegalGate } from "./service.js";
import { resolveLegalCaps } from "./caps.js";
import { deterministicNamingPrecheck } from "./precheck.js";
import { loadConfig } from "../config/loader.js";
import { createRequest } from "../db/repositories/approvals.js";
import { getIdea } from "../db/repositories/venture.js";
import {
  dbConsentStore,
  dbDataRightsStore,
  dbLegalDocStore,
  dbLegalFactsStore,
  dbSuppressionStore,
} from "../db/repositories/legal.js";

/**
 * Production wiring for the Legal & Compliance pack (#196, ADR-0196). The legal facts / documents /
 * suppression / consent / data-rights stores are the workspace-scoped `legal` repo; the gate creates a
 * **pending** #13 approval (`external.send` is sensitive-by-default, ADR-0013) so a human owner reviews +
 * publishes legal docs and ratifies naming decisions in the decision queue. No change to
 * `approvals/policy.ts` or the executor. The naming pre-check is the deterministic stand-in (no real
 * WHOIS/USPTO) — swap a real provider here when one is wired. Default OFF (`legal.enabled`).
 */
const legalGate: LegalGate = {
  submit: async (input) => {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: input.actionType,
      payload: input.payload,
      amount: input.amount,
      summary: input.summary,
      status: "pending", // external.send is sensitive-by-default — always a human gate (owner review)
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "legal", summary: input.summary } }],
    });
    return { id: req.id };
  },
};

export function createDefaultLegalService(): LegalService {
  return new LegalService({
    facts: dbLegalFactsStore,
    documents: dbLegalDocStore,
    suppressions: dbSuppressionStore,
    consent: dbConsentStore,
    dataRights: dbDataRightsStore,
    gate: legalGate,
    precheck: deterministicNamingPrecheck,
    // #19 IDOR: a legal fact/doc/decision may only attach to a venture idea in the same workspace.
    ventures: { exists: async (wid, ideaId) => (await getIdea(wid, ideaId)) !== undefined },
    caps: (workspaceId) => resolveLegalCaps(loadConfig(workspaceId).legal),
  });
}
