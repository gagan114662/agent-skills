import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config/loader.js";
import { resolveSiteUrl } from "../marketing/site.js";
import { createRequest } from "../db/repositories/approvals.js";
import { getPersonaByHandle } from "../db/repositories/personas.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { dbSuppressionStore } from "../db/repositories/acquisition.js";
import {
  dbReachContactStore,
  dbReachReceiptStore,
  dbReachRunStore,
  dbReachSendStore,
} from "../db/repositories/reach.js";
import { REACH_DATA_CREDIT_ACTION } from "../approvals/policy.js";
import { resolveReachCaps, isOwnerWorkspace } from "./caps.js";
import { createEmailChannel } from "./channels/email.js";
import { createLinkedInChannel } from "./channels/linkedin.js";
import { createProspectSource, type HttpFetch } from "./sources/index.js";
import { ReachService, type ReachDeps } from "./service.js";

/** The Reach department lead's @handle — the persona that owns the channel + is the money-gate requester. */
export const REACH_AGENT_HANDLE = "comet";

/** Extract a bare host from a URL ("https://ipop.ai/x" → "ipop.ai"). */
function hostOf(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

/** A real `fetch`-backed HTTP seam for the paid prospect sources. */
const realHttpFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

/**
 * Wire the production {@link ReachService} (#280). Default-OFF + `mock` source + `dryrun` email sender, so
 * a deployment that sets nothing spends nothing and sends nothing. The email channel sends recorded-only
 * through the dry-run sender until a real ESP is connected (a deliberate follow-up behind the #192 vault);
 * LinkedIn queues (no permitted send path wired). The paid sources resolve their key from the #192 vault
 * and never log it.
 */
export function createDefaultReachService(log?: FastifyBaseLogger): ReachService {
  const channels: ReachDeps["channels"] = {
    // Real ESP / permitted LinkedIn senders slot in here behind the #192 vault (a follow-up); the defaults
    // are recorded-only (email dry-run) and queue-only (LinkedIn), the byte-for-byte safe default.
    email: createEmailChannel(),
    linkedin: createLinkedInChannel(),
  };

  return new ReachService({
    log,
    caps: (workspaceId) => resolveReachCaps(loadConfig(workspaceId).reach),
    icp: {
      async seed(workspaceId) {
        const cfg = loadConfig(workspaceId);
        const siteUrl = resolveSiteUrl({
          workspaceId,
          ownerWorkspaceId: cfg.marketing.ownerWorkspaceId,
          configuredSiteUrl: cfg.marketing.siteUrl,
        });
        const domain = siteUrl ? hostOf(siteUrl) : "ipop.ai";
        // For the owner's own workspace, seed the ICP with the dogfood wedge's high-intent keywords so
        // Reach targets the exact founders ipop sells to; other workspaces fall back to the domain label.
        const owner = isOwnerWorkspace(resolveReachCaps(cfg.reach), workspaceId);
        const productKeywords = owner
          ? ["ai marketing agency", "autonomous growth team", "marketing without a team"]
          : undefined;
        return { domain, productKeywords };
      },
    },
    resolveSource: (workspaceId, kind) =>
      createProspectSource(kind, {
        httpFetch: realHttpFetch,
        loadApiKey: async (serviceKey, envKey) => {
          const secrets = await resolveServiceSecrets(workspaceId, serviceKey);
          return secrets[envKey] ?? null;
        },
      }),
    channels,
    contacts: dbReachContactStore,
    sends: dbReachSendStore,
    receipts: dbReachReceiptStore,
    runs: dbReachRunStore,
    suppressions: { loadSuppressed: (workspaceId) => dbSuppressionStore.loadSuppressed(workspaceId) },
    approvals: {
      async submitDataCreditSpend(input) {
        // The Reach lead persona is the requester for the autonomous money gate (an agent member, never a
        // human) — consistent with how the monetization / outreach money actions are parked.
        const persona = await getPersonaByHandle(input.workspaceId, REACH_AGENT_HANDLE);
        if (!persona) {
          throw new Error(`reach persona @${REACH_AGENT_HANDLE} not found — seed the department before enabling a paid source`);
        }
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: persona.agentMemberId,
          actionType: REACH_DATA_CREDIT_ACTION,
          payload: { provider: input.provider, amountCents: input.amountCents, prospectCount: input.prospectCount },
          amount: input.amountCents,
          summary: input.summary,
          status: "pending",
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "reach", provider: input.provider } }],
        });
        return { requestId: req.id };
      },
    },
  });
}
