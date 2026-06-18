import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config/loader.js";
import { resolveSiteUrl } from "../marketing/site.js";
import {
  GOOGLE_CONNECTION_SERVICE_KEY,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
} from "../auth/google-oauth.js";
import { SEARCH_CONSOLE_SUBMIT_ACTION } from "../approvals/policy.js";
import { createRequest } from "../db/repositories/approvals.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { dbSearchConsoleSubmissionStore } from "../db/repositories/search-console.js";
import { resolveSearchConsoleCaps } from "./caps.js";
import { resolveSearchConsoleProvider } from "./provider.js";
import { SearchConsoleService } from "./service.js";

/**
 * True iff the workspace has a connected Google account whose grant includes the Search Console WRITE scope
 * (`webmasters`, #260). We read the sealed `google` connection secrets from the #192 vault and check the
 * recorded scope — proving the workspace actually granted the scope Scout needs to submit, not just "some"
 * Google connection. Tenant-scoped (#3).
 */
export async function searchConsoleConnected(workspaceId: string): Promise<boolean> {
  const secrets = await resolveServiceSecrets(workspaceId, GOOGLE_CONNECTION_SERVICE_KEY);
  const scope = secrets.GOOGLE_OAUTH_SCOPE ?? "";
  return scope.split(/\s+/).includes(GOOGLE_SEARCH_CONSOLE_SCOPE);
}

/**
 * Wire the production {@link SearchConsoleService} (#265). Default-OFF + `dryrun` provider + structural #13
 * always-gate — three independent safety layers, so a deployment that sets nothing submits nothing and
 * records nothing. The provider seam resolves to the dry-run provider until a real Search Console provider
 * is built behind the #192 vault (a deliberate follow-up; no credentials in this change). The approval seam
 * ALWAYS parks a PENDING `searchconsole.submit` request (the service has no autonomous submit path) — the
 * live submit only ever runs through the post-approval executor.
 */
export function createDefaultSearchConsoleService(log?: FastifyBaseLogger): SearchConsoleService {
  return new SearchConsoleService({
    log,
    store: dbSearchConsoleSubmissionStore,
    caps: (workspaceId) => resolveSearchConsoleCaps(loadConfig(workspaceId).seo),
    provider: (kind) => resolveSearchConsoleProvider(kind),
    siteUrl: (workspaceId) => {
      const cfg = loadConfig(workspaceId);
      return (
        resolveSiteUrl({
          workspaceId,
          ownerWorkspaceId: cfg.marketing.ownerWorkspaceId,
          configuredSiteUrl: cfg.marketing.siteUrl,
        }) ?? ""
      );
    },
    searchConsoleConnected,
    approvals: {
      submit: async (input) => {
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: SEARCH_CONSOLE_SUBMIT_ACTION,
          payload: input.payload,
          amount: null,
          summary: input.summary,
          status: "pending", // outward live submit to Google — parks in the decision queue (ADR-0265)
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "search_console", ...input.payload } }],
        });
        return { id: req.id };
      },
    },
    now: () => new Date(),
  });
}
