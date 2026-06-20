import { loadConfig } from "../config/loader.js";

/**
 * Production wiring helper for inbound lead capture (GAP 1 of the leads centre, ADR-0400). Resolves the
 * workspace a public landing lead belongs to: the marketing-owner workspace (`marketing.ownerWorkspaceId`,
 * the established #258 marker). With no owner configured the public route 503s — capture is wired the
 * moment the deployment names its own workspace, which it already does for the dogfood marketing fleet.
 *
 * Capture is ON by default (no off-by-default gate): the only condition is having a workspace to attribute
 * the lead to. Resolving here keeps `app.ts` free of config-loading.
 */
export function resolveInboundLeadsOwnerWorkspaceId(): string | undefined {
  return loadConfig().marketing?.ownerWorkspaceId;
}
