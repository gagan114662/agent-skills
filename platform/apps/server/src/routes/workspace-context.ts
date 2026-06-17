import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import {
  getWorkspaceOnboarding,
  setWorkspaceDomain,
  setWorkspaceProductContext,
} from "../db/repositories/workspace-onboarding.js";
import {
  resolveWorkspaceFacts,
  shouldInjectWorkspaceContext,
  composeWorkspaceContextPreamble,
  sanitizeContextValue,
  BRAND_VOICE_LINE,
  MAX_PRODUCT_CONTEXT_CHARS,
} from "../marketing/workspace-context.js";

/**
 * Workspace-context capture (#320, ADR-0320). The first-run/onboarding surface that lets the owner put the
 * company's primary site URL + product context on file so briefed agents (Scout/Lens/…) act on real facts
 * instead of returning placeholder drafts. `/me/*`-scoped to the caller's workspace (#3).
 *
 *  - GET  /me/workspace-context — the resolved facts (site URL + product context + brand voice), the exact
 *    preamble an agent would receive, and whether injection is active for this workspace. Read-only; always
 *    available so the console can render the form pre-filled.
 *  - PUT  /me/workspace-context — capture the typed domain and/or product context. Gated behind the
 *    default-OFF, owner-workspace-first flag (returns 409 when not enabled), mirroring the #192 onboarding
 *    routes. The product context is sanitized + bounded before it is ever surfaced to an agent.
 */
export async function workspaceContextRoutes(app: FastifyInstance): Promise<void> {
  function factsFor(workspaceId: string, onboarding: { domain: string | null; productContext: string | null } | null) {
    const marketing = loadConfig(workspaceId).marketing;
    return resolveWorkspaceFacts({
      workspaceId,
      ownerWorkspaceId: marketing.ownerWorkspaceId,
      configuredSiteUrl: marketing.siteUrl,
      domain: onboarding?.domain ?? null,
      productContext: onboarding?.productContext ?? null,
      brandVoice: BRAND_VOICE_LINE,
    });
  }

  app.get("/me/workspace-context", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const onboarding = await getWorkspaceOnboarding(identity.workspaceId);
    const facts = factsFor(identity.workspaceId, onboarding);
    const marketing = loadConfig(identity.workspaceId).marketing;
    return {
      facts,
      preamble: composeWorkspaceContextPreamble(facts),
      injectionEnabled: shouldInjectWorkspaceContext(marketing, identity.workspaceId),
      // echo the stored raw values so the form can pre-fill (these are owner-authored, not secrets).
      domain: onboarding?.domain ?? null,
      productContext: onboarding?.productContext ?? null,
    };
  });

  app.put("/me/workspace-context", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const marketing = loadConfig(identity.workspaceId).marketing;
    if (!shouldInjectWorkspaceContext(marketing, identity.workspaceId)) {
      return reply.code(409).send({ error: "workspace-context capture not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as { domain?: unknown; productContext?: unknown };

    const domain =
      typeof body.domain === "string" && body.domain.trim() !== "" ? body.domain.trim() : undefined;
    // Product context is owner free text — sanitize + bound it here too (defense-in-depth), so what is
    // stored is already safe to surface as DATA. An empty/blank string is rejected (nothing to capture).
    const productContext =
      typeof body.productContext === "string" && sanitizeContextValue(body.productContext) !== ""
        ? sanitizeContextValue(body.productContext)
        : undefined;

    if (domain === undefined && productContext === undefined) {
      return reply
        .code(400)
        .send({ error: "provide a domain and/or productContext to capture", maxProductContextChars: MAX_PRODUCT_CONTEXT_CHARS });
    }
    if (domain !== undefined) await setWorkspaceDomain(identity.workspaceId, domain);
    if (productContext !== undefined) await setWorkspaceProductContext(identity.workspaceId, productContext);

    const onboarding = await getWorkspaceOnboarding(identity.workspaceId);
    const facts = factsFor(identity.workspaceId, onboarding);
    return { ok: true, facts, preamble: composeWorkspaceContextPreamble(facts) };
  });
}
