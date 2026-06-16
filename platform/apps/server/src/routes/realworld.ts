import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveRealworldCaps } from "../realworld/caps.js";
import { realWorldReadinessNeeded } from "../realworld/decide.js";
import { connectedAccountKinds, createDefaultSitePublisher } from "../realworld/default.js";
import type { RealWorldActuatorService } from "../realworld/service.js";
import { listArtifacts } from "../db/repositories/realworld-artifacts.js";
import { createDefaultAssetService } from "../assets/default.js";

/** Canonical UUID form — `draft_ref`/`venture_id` are uuid columns, so a non-UUID would 500 on insert. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Real-world tool surface routes (#231, ADR-0231). Read-only and `/me/*`-scoped to the caller's
 * workspace (#3). Surfaces what the fleet CAN do in the real world right now: each tool's gate decision,
 * exactly which external accounts the owner must still connect before a venture can do real work, and
 * the receipts of what's actually been published/parked/blocked. The one write is self-publish to
 * ipop.ai (#250): committing content + opening a PR against ipop's OWN repo is money-free + reversible,
 * so it is AUTONOMOUS (no #13 gate, per #243 money-only). A live page deploy still routes through #13.
 */
export async function realworldRoutes(
  app: FastifyInstance,
  opts: { service: RealWorldActuatorService },
): Promise<void> {
  const { service } = opts;

  app.get("/me/realworld", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const enabled = resolveRealworldCaps(loadConfig(wid).realworld).enabled;
    const [availability, connectedKinds, artifacts] = await Promise.all([
      service.availability(wid),
      connectedAccountKinds(wid),
      listArtifacts(wid, 20),
    ]);
    return {
      enabled,
      neededAccounts: realWorldReadinessNeeded(connectedKinds),
      availability,
      artifacts,
    };
  });

  /**
   * Self-publish to ipop.ai (#250): commit a content file + open a PR against ipop's own site repo.
   * AUTONOMOUS — opening a PR is money-free + reversible (#243). Gated only by the realworld master flag
   * being on (default OFF). The provider is dry-run unless `realworld.sitePrProvider = "github"` + a repo
   * + a server token are configured, so this never touches a real repo by default.
   */
  app.post("/me/realworld/publish-site", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    if (!resolveRealworldCaps(loadConfig(wid).realworld).enabled) {
      return reply.code(403).send({ error: "the real-world tool surface is disabled for this workspace" });
    }
    const body = (req.body ?? {}) as {
      title?: string;
      content?: string;
      slug?: string;
      prBody?: string;
      extension?: string;
      ventureId?: string | null;
    };
    if (!body.title || !body.content) {
      return reply.code(400).send({ error: "title and content are required" });
    }
    const publisher = await createDefaultSitePublisher(wid);
    const result = await publisher.publish({
      workspaceId: wid,
      ventureId: body.ventureId ?? null,
      title: body.title,
      content: body.content,
      slug: body.slug,
      body: body.prBody,
      extension: body.extension,
    });
    if (result.status === "rejected") return reply.code(400).send({ error: result.reason });
    // No publishing connection (e.g. customer hasn't connected their website) — actionable 409.
    if (result.status === "not_connected") return reply.code(409).send({ error: result.reason });
    if (result.status === "failed") return reply.code(502).send({ error: result.error });
    return result;
  });

  /**
   * Generate an on-brand image into the workspace asset store (#271), optionally attached to a draft
   * (the `agent.deliverable` approval card, via `draftRef`). AUTONOMOUS — generation is a fleet operating
   * cost, not a #243 money action, so there is NO #13 gate. Mark enforces the brand: with no brand kit
   * set, this 400s ("set the brand kit first"); the image is rendered FROM the kit palette and re-checked
   * before it is stored. Gated only by the real-world master flag (default OFF) + the default dry-run
   * provider, so it never touches anything external by default.
   */
  app.post("/me/realworld/generate-image", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    if (!resolveRealworldCaps(loadConfig(wid).realworld).enabled) {
      return reply.code(403).send({ error: "the real-world tool surface is disabled for this workspace" });
    }
    const body = (req.body ?? {}) as {
      prompt?: string;
      title?: string;
      draftRef?: string | null;
      ventureId?: string | null;
    };
    if (!body.prompt || !body.prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    // draft_ref / venture_id are uuid columns — validate before insert so a bad ref is a clean 400, not a 500.
    const draftRef = typeof body.draftRef === "string" && body.draftRef.trim() ? body.draftRef.trim() : null;
    const ventureId = typeof body.ventureId === "string" && body.ventureId.trim() ? body.ventureId.trim() : null;
    if (draftRef && !UUID_RE.test(draftRef)) {
      return reply.code(400).send({ error: "draftRef must be a valid UUID" });
    }
    if (ventureId && !UUID_RE.test(ventureId)) {
      return reply.code(400).send({ error: "ventureId must be a valid UUID" });
    }
    const svc = createDefaultAssetService(wid);
    const result = await svc.generateImage({
      workspaceId: wid,
      ventureId,
      prompt: body.prompt,
      title: body.title,
      draftRef,
    });
    if (result.status === "rejected") {
      return reply.code(400).send({ error: result.reason, violations: result.violations });
    }
    return result;
  });

  /** The workspace's stored brand assets (generated + uploaded), newest first. Read-only. */
  app.get("/me/realworld/assets", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const svc = createDefaultAssetService(wid);
    const assets = await svc.listAssets(wid, 50);
    return { assets };
  });
}
