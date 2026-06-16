import { evaluatePolicy, REALWORLD_PUBLISH_ACTION } from "../approvals/policy.js";
import { createRequest, listPolicyRules } from "../db/repositories/approvals.js";
import { listServiceStatuses, resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { listSetupRequests } from "../db/repositories/setup-requests.js";
import { dbArtifactStore } from "../db/repositories/realworld-artifacts.js";
import type { ServiceKind } from "../onboarding/types.js";
import { RealWorldActuatorService } from "./service.js";
import type { PublishProvider } from "./publish/provider.js";
import { DryRunPublishProvider } from "./publish/dry-run-provider.js";
import { resolveSitePublisher, type SitePublisher } from "./publish/site-publisher.js";
import { loadConfig } from "../config/loader.js";

/**
 * The external account KINDS connected for a workspace (#231). The #192 vault stores credentials by
 * `service_key`; the KIND lives on the setup request, so we join the connected keys to their request to
 * learn which account kinds (hosting/ESP/registrar/ad) are live. That set gates the account-dependent
 * real-world tools and drives the "what to connect" readiness signal. Tenant-scoped (#3).
 */
export async function connectedAccountKinds(workspaceId: string): Promise<Set<ServiceKind>> {
  const [creds, requests] = await Promise.all([
    listServiceStatuses(workspaceId),
    listSetupRequests(workspaceId),
  ]);
  const kindByKey = new Map<string, ServiceKind>(
    requests.map((r) => [r.serviceKey, r.serviceKind as ServiceKind]),
  );
  const kinds = new Set<ServiceKind>();
  for (const cred of creds) {
    if (!cred.connected) continue;
    const kind = kindByKey.get(cred.serviceKey);
    if (kind) kinds.add(kind);
  }
  return kinds;
}

/**
 * Wire the {@link RealWorldActuatorService} to the real repos + the #13 gate (#231). The publish
 * provider defaults to the non-reachable {@link DryRunPublishProvider} — the live GitHub Pages provider
 * is selected explicitly (config `realworld.publishProvider` via the lazy factory) only when an owner
 * opts in. `realworld.publish` is sensitive by default: the gate parks a PENDING request the blocked
 * publish ages in, exactly like `setup.external_account` / `venture.deploy`.
 */
export function createDefaultRealworldActuatorService(
  opts: { publish?: PublishProvider } = {},
): RealWorldActuatorService {
  return new RealWorldActuatorService({
    publish: opts.publish ?? new DryRunPublishProvider(),
    artifacts: dbArtifactStore,
    approvals: {
      requiresApproval: async (workspaceId) =>
        evaluatePolicy({ actionType: REALWORLD_PUBLISH_ACTION }, await listPolicyRules(workspaceId))
          .requiresApproval,
      submit: async (input) => {
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: REALWORLD_PUBLISH_ACTION,
          payload: input.payload,
          amount: null,
          summary: input.summary,
          status: "pending", // outward brand surface — parks in the decision queue (ADR-0231)
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "realworld", ...input.payload } }],
        });
        return { id: req.id };
      },
    },
    connectedAccounts: (workspaceId) => connectedAccountKinds(workspaceId),
  });
}

/**
 * Wire the AUTONOMOUS self-publish {@link SitePublisher} (#258, was #250). `publish_site` resolves an
 * abstract publisher per workspace: the internal GitHub impl reads its token + repo from the ENCRYPTED
 * per-workspace connection (#192 vault), NOT a Fly server secret — so the token is no longer infra. Falls
 * back to a legacy env-token config path, then to a dry-run publisher (the safe internal default — no
 * network). Opening a PR is money-free + reversible, so there is NO #13 gate here (#243 money-only) — the
 * publisher has no send/spend seam, and a poisoned read can at most draft a PR a human still merges.
 */
export async function createDefaultSitePublisher(workspaceId: string): Promise<SitePublisher> {
  const cfg = loadConfig(workspaceId).realworld;
  return resolveSitePublisher(workspaceId, {
    readConnectionSecrets: (wid, id) => resolveServiceSecrets(wid, id),
    config: {
      sitePrProvider: cfg.sitePrProvider,
      siteRepo: cfg.siteRepo,
      siteBaseBranch: cfg.siteBaseBranch,
      siteContentDir: cfg.siteContentDir,
    },
    artifacts: dbArtifactStore,
  });
}
