import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveOnboardingCaps } from "../onboarding/caps.js";
import type { OnboardingService } from "../onboarding/service.js";
import type { RequiredService } from "../onboarding/types.js";
import { listDnsReceipts } from "../db/repositories/dns-receipts.js";

/**
 * External account onboarding routes (#192, ADR-0192). All `/me/*`-scoped to the caller's workspace (#3).
 *
 * READS (the checklist + receipts) always work so the console can render the feature. The risky WRITES —
 * filing setup needs (which queues #13 approvals), connecting credentials (the write-only vault), DNS
 * configuration (autonomous agent action), and revocation — are gated behind `onboarding.enabled` and
 * return 409 when the workspace hasn't opted in (owner workspace first). The connect route is write-only:
 * it takes a plain secret map in and returns the status only — never echoes a key back.
 */
export async function onboardingRoutes(
  app: FastifyInstance,
  opts: { service: OnboardingService },
): Promise<void> {
  const { service } = opts;

  function enabled(workspaceId: string): boolean {
    return resolveOnboardingCaps(loadConfig(workspaceId).onboarding).enabled;
  }

  // The guided setup checklist (requests + connection state + rotation reminders). Read-only.
  app.get("/me/external-services", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return service.checklist(identity.workspaceId);
  });

  // File the services a venture needs (acceptance 1) — each missing one parks a #13 approval (acceptance 5).
  app.post("/me/external-services", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as { required?: unknown };
    const required = parseRequired(body.required);
    if (!required) return reply.code(400).send({ error: "required[] of services is required" });
    const filed = await service.fileSetupNeeds({
      workspaceId: identity.workspaceId,
      required,
      requesterMemberId: identity.memberId,
    });
    return {
      filed: filed.map((f) => ({
        serviceKey: f.spec.serviceKey,
        summary: f.spec.summary,
        reversibility: f.spec.reversibility,
        requiresHuman: f.spec.requiresHuman,
        approvalRequestId: f.approvalRequestId,
      })),
    };
  });

  // Connect (or re-connect) a service's credentials. WRITE-ONLY — sealed in the vault, never echoed back.
  app.put("/me/external-credentials/:service", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const serviceKey = (req.params as { service: string }).service;
    const body = (req.body ?? {}) as {
      secrets?: unknown;
      scopes?: unknown;
      rotationReminderDays?: unknown;
    };
    const secrets = parseSecrets(body.secrets);
    if (!secrets) {
      return reply.code(400).send({ error: "secrets must be a non-empty {ENV_VAR: value} map" });
    }
    return service.connect({
      workspaceId: identity.workspaceId,
      serviceKey,
      secrets,
      scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : undefined,
      rotationReminderDays:
        typeof body.rotationReminderDays === "number" ? body.rotationReminderDays : undefined,
      connectedByMemberId: identity.memberId,
    });
  });

  // Revoke a service — dependent capabilities go offline gracefully (acceptance 4). Idempotent.
  app.delete("/me/external-credentials/:service", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const serviceKey = (req.params as { service: string }).service;
    await service.revoke(identity.workspaceId, serviceKey);
    return { revoked: true, serviceKey };
  });

  // Configure + verify a domain's DNS/SSL/email-auth records autonomously, with receipts (acceptance 3).
  app.post("/me/external-dns", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as {
      domain?: unknown;
      appTarget?: unknown;
      spfIncludes?: unknown;
      dkim?: unknown;
      dmarcRua?: unknown;
      verificationToken?: unknown;
    };
    if (typeof body.domain !== "string" || body.domain.trim() === "") {
      return reply.code(400).send({ error: "domain is required" });
    }
    const dkim =
      body.dkim && typeof body.dkim === "object"
        ? (body.dkim as { selector?: unknown; publicKey?: unknown })
        : undefined;
    return service.configureDns({
      workspaceId: identity.workspaceId,
      plan: {
        domain: body.domain.trim(),
        appTarget: typeof body.appTarget === "string" ? body.appTarget : undefined,
        spfIncludes: Array.isArray(body.spfIncludes)
          ? body.spfIncludes.filter((s): s is string => typeof s === "string")
          : undefined,
        dkim:
          dkim && typeof dkim.selector === "string" && typeof dkim.publicKey === "string"
            ? { selector: dkim.selector, publicKey: dkim.publicKey }
            : undefined,
        dmarcRua: typeof body.dmarcRua === "string" ? body.dmarcRua : undefined,
        verificationToken:
          typeof body.verificationToken === "string" ? body.verificationToken : undefined,
      },
    });
  });

  // The immutable DNS receipts for the workspace (optionally one domain). Read-only.
  app.get("/me/external-dns/receipts", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const domain = (req.query as { domain?: string }).domain;
    return { receipts: await listDnsReceipts(identity.workspaceId, domain) };
  });
}

/** Parse the `required[]` setup payload, dropping malformed entries. Returns null when none are valid. */
function parseRequired(value: unknown): RequiredService[] | null {
  if (!Array.isArray(value)) return null;
  const out: RequiredService[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.serviceKey !== "string" || typeof r.serviceKind !== "string") continue;
    if (typeof r.displayName !== "string" || typeof r.reason !== "string") continue;
    out.push({
      serviceKey: r.serviceKey,
      serviceKind: r.serviceKind as RequiredService["serviceKind"],
      displayName: r.displayName,
      reason: r.reason,
      plan: typeof r.plan === "string" ? r.plan : null,
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [],
      projectedCostCents: typeof r.projectedCostCents === "number" ? r.projectedCostCents : 0,
      envKeys: Array.isArray(r.envKeys) ? r.envKeys.filter((s): s is string => typeof s === "string") : [],
    });
  }
  return out.length > 0 ? out : null;
}

/** Parse a `{ENV_VAR: value}` secret map, dropping non-string values. Returns null when empty. */
function parseSecrets(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
