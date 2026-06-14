import type { FastifyBaseLogger } from "fastify";
import { OnboardingService } from "./service.js";
import { createDnsProvider } from "./dns/factory.js";
import type { DnsProvider } from "./dns/provider.js";
import { resolveOnboardingCaps } from "./caps.js";
import { loadConfig } from "../config/loader.js";
import { evaluatePolicy, SETUP_EXTERNAL_ACCOUNT_ACTION } from "../approvals/policy.js";
import { isMoneyServiceKind } from "./types.js";
import { createRequest, listPolicyRules } from "../db/repositories/approvals.js";
import {
  upsertSetupRequest,
  listSetupRequests,
  setSetupRequestStatus,
} from "../db/repositories/setup-requests.js";
import {
  setServiceCredentials,
  listServiceStatuses,
  revokeServiceCredentials,
} from "../db/repositories/external-credentials.js";
import { recordDnsReceipts, listDnsReceipts } from "../db/repositories/dns-receipts.js";

/**
 * Wire the {@link OnboardingService} to the real repos + the #13 approval gate + the DNS provider
 * (#192, ADR-0192). Mirrors `portfolio/default.ts`: the approval gate evaluates `setup.external_account`
 * (sensitive by default) against the workspace policy and, when gated, creates a PENDING request the
 * blocked setup parks into. The DNS provider defaults to the no-network `DryRunDnsProvider`; a real
 * adapter is selected by `onboarding.dnsProvider` (lazy). Secrets never leave the vault here.
 */
export function createDefaultOnboardingService(
  _log: FastifyBaseLogger,
  opts: { dnsProvider?: DnsProvider } = {},
): OnboardingService {
  const serverCaps = resolveOnboardingCaps(loadConfig().onboarding);
  const dns = createDnsProvider({ provider: serverCaps.dnsProvider }, opts.dnsProvider);
  return new OnboardingService({
    setupRequests: {
      upsert: (input) => upsertSetupRequest(input),
      list: (workspaceId) => listSetupRequests(workspaceId),
      setStatus: (workspaceId, serviceKey, status) =>
        setSetupRequestStatus(workspaceId, serviceKey, status),
    },
    credentials: {
      set: (input) => setServiceCredentials(input),
      list: (workspaceId) => listServiceStatuses(workspaceId),
      revoke: (workspaceId, serviceKey) => revokeServiceCredentials(workspaceId, serviceKey),
    },
    dnsReceipts: {
      record: (input) => recordDnsReceipts(input),
      list: (workspaceId, domain) => listDnsReceipts(workspaceId, domain),
    },
    // #13 setup gate (#243 money-only): connecting LIVE payment credentials (`payment` kind) is the only
    // MONEY connect, so it parks a PENDING owner approval. Every other external-account connect (hosting,
    // ESP, registrar, analytics, ads) is autonomous — it still shows on the setup checklist as a human
    // paste-the-key step, but it never pauses for an owner approval.
    approvals: {
      requiresApproval: async (workspaceId, serviceKind) =>
        isMoneyServiceKind(serviceKind) &&
        evaluatePolicy(
          { actionType: SETUP_EXTERNAL_ACCOUNT_ACTION },
          await listPolicyRules(workspaceId),
        ).requiresApproval,
      submit: async (input) => {
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: SETUP_EXTERNAL_ACCOUNT_ACTION,
          payload: input.payload,
          amount: null,
          summary: input.summary,
          status: "pending", // setup ALWAYS needs the owner — parks in the decision queue (ADR-0192)
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "onboarding", ...input.payload } }],
        });
        return { id: req.id };
      },
    },
    dns,
    resolveCaps: (workspaceId) => resolveOnboardingCaps(loadConfig(workspaceId).onboarding),
    now: () => Date.now(),
  });
}
