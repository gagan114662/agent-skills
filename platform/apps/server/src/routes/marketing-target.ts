import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import {
  getWorkspaceOnboarding,
  setMarketingTarget,
  type MarketingTargetInput,
} from "../db/repositories/workspace-onboarding.js";
import {
  resolveWorkspaceFacts,
  composeWorkspaceContextPreamble,
  hasExplicitMarketingTarget,
  sanitizeContextValue,
  sanitizeUrl,
  BRAND_VOICE_LINE,
  MAX_PRODUCT_NAME_CHARS,
  MAX_POSITIONING_CHARS,
  MAX_AUDIENCE_CHARS,
  MAX_COMPETITORS_CHARS,
  MAX_SITE_URL_CHARS,
} from "../marketing/workspace-context.js";

/**
 * The "What are we marketing?" surface (#502): point the fleet at a TARGET — the workspace's own product OR
 * any external app/URL — and capture the brief the agents pull from (name, URL, one-line positioning, target
 * customer/ICP, competitors). This is the single source of truth: once set, every briefed agent's task is
 * enriched with it (`marketing/workspace-context.ts` + the `enrichTask` seam) so the fleet markets THAT
 * product instead of inferring ipop.
 *
 * Unlike the #320 `/me/workspace-context` route (owner-workspace-first, flag-gated for dogfooding), this is
 * available to ANY authenticated workspace — that is the whole point of "market any company". `/me/*`-scoped
 * to the caller's workspace (#3). The typed values are owner-authored DATA: sanitized + length-bounded here
 * (defense-in-depth) and again at the read seam before they ever reach an agent (never run as instructions,
 * #200 FM#6). Nothing here sends, spends, or gates — agents still carry only draft tools (#13 holds sends).
 *
 *  - GET /me/marketing-target — the stored target (pre-fills the form), whether it is configured, and the
 *    exact brief preamble an agent would receive.
 *  - PUT /me/marketing-target — capture/update the target. Each field is optional; at least one is required.
 */
export async function marketingTargetRoutes(app: FastifyInstance): Promise<void> {
  function viewFor(
    workspaceId: string,
    onboarding: {
      domain: string | null;
      productContext: string | null;
      targetName: string | null;
      targetPositioning: string | null;
      targetAudience: string | null;
      targetCompetitors: string | null;
    } | null,
  ) {
    const marketing = loadConfig(workspaceId).marketing;
    const facts = resolveWorkspaceFacts({
      workspaceId,
      ownerWorkspaceId: marketing.ownerWorkspaceId,
      configuredSiteUrl: marketing.siteUrl,
      domain: onboarding?.domain ?? null,
      productContext: onboarding?.productContext ?? null,
      productName: onboarding?.targetName ?? null,
      positioning: onboarding?.targetPositioning ?? null,
      audience: onboarding?.targetAudience ?? null,
      competitors: onboarding?.targetCompetitors ?? null,
      brandVoice: BRAND_VOICE_LINE,
    });
    return {
      configured: hasExplicitMarketingTarget(onboarding),
      // Echo the stored raw values (owner-authored, not secrets) so the form pre-fills.
      target: {
        name: onboarding?.targetName ?? null,
        url: onboarding?.domain ?? null,
        positioning: onboarding?.targetPositioning ?? null,
        audience: onboarding?.targetAudience ?? null,
        competitors: onboarding?.targetCompetitors ?? null,
      },
      // The exact brief the fleet reads — so the owner can preview what the agents will act on.
      preamble: composeWorkspaceContextPreamble(facts),
    };
  }

  app.get("/me/marketing-target", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const onboarding = await getWorkspaceOnboarding(identity.workspaceId);
    return viewFor(identity.workspaceId, onboarding);
  });

  app.put("/me/marketing-target", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as {
      name?: unknown;
      url?: unknown;
      positioning?: unknown;
      audience?: unknown;
      competitors?: unknown;
    };

    // Sanitize + bound each field here too (defense-in-depth): what we store is already safe to surface as
    // DATA. A blank/whitespace value clears nothing — only present, non-empty fields are written.
    const clean = (v: unknown, max: number): string | undefined => {
      if (typeof v !== "string") return undefined;
      const s = sanitizeContextValue(v, max);
      return s === "" ? undefined : s;
    };
    const url = typeof body.url === "string" && sanitizeUrl(body.url) !== "" ? sanitizeUrl(body.url) : undefined;

    const update: MarketingTargetInput = {
      ...(url !== undefined ? { domain: url } : {}),
      ...(clean(body.name, MAX_PRODUCT_NAME_CHARS) !== undefined
        ? { name: clean(body.name, MAX_PRODUCT_NAME_CHARS) }
        : {}),
      ...(clean(body.positioning, MAX_POSITIONING_CHARS) !== undefined
        ? { positioning: clean(body.positioning, MAX_POSITIONING_CHARS) }
        : {}),
      ...(clean(body.audience, MAX_AUDIENCE_CHARS) !== undefined
        ? { audience: clean(body.audience, MAX_AUDIENCE_CHARS) }
        : {}),
      ...(clean(body.competitors, MAX_COMPETITORS_CHARS) !== undefined
        ? { competitors: clean(body.competitors, MAX_COMPETITORS_CHARS) }
        : {}),
    };

    if (Object.keys(update).length === 0) {
      return reply.code(400).send({
        error: "tell the fleet what to market — provide at least a name, URL, or positioning",
        limits: {
          name: MAX_PRODUCT_NAME_CHARS,
          url: MAX_SITE_URL_CHARS,
          positioning: MAX_POSITIONING_CHARS,
          audience: MAX_AUDIENCE_CHARS,
          competitors: MAX_COMPETITORS_CHARS,
        },
      });
    }

    await setMarketingTarget(identity.workspaceId, update);
    const onboarding = await getWorkspaceOnboarding(identity.workspaceId);
    return { ok: true, ...viewFor(identity.workspaceId, onboarding) };
  });
}
