import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveOnboardingCaps } from "../onboarding/caps.js";
import type { OnboardingService } from "../onboarding/service.js";
import type { DnsManager } from "../onboarding/dns/manager.js";
import type { RequiredService } from "../onboarding/types.js";
import { listDnsReceipts } from "../db/repositories/dns-receipts.js";
import {
  buildDeliverable,
  deriveBusiness,
  planToFrames,
  type DeliverableBusiness,
} from "../onboarding/deliverable.js";

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
  opts: { service: OnboardingService; dnsManager: DnsManager },
): Promise<void> {
  const { service, dnsManager } = opts;

  function enabled(workspaceId: string): boolean {
    return resolveOnboardingCaps(loadConfig(workspaceId).onboarding).enabled;
  }

  // Every open deliverable stream registers a teardown here so a server shutdown ends them all (no leak).
  const activeStreams = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const stop of activeStreams) stop();
    activeStreams.clear();
  });

  // -------------------------------------------------------------------------------------------------
  // #633 OUTCOME-FIRST ONBOARDING: produce a real deliverable before asking for config.
  //
  // PUBLIC + UNAUTHENTICATED on purpose — a brand-new visitor types a URL and immediately watches a real,
  // personalized artifact appear, with zero setup first. The Google sign-in / config happens in parallel in
  // the browser, never as a gate. This route is a pure, offline generator: it derives everything from the
  // typed URL (no DB, no outbound fetch → no SSRF), so it is deterministic and finishes well inside ~60s.
  // The URL is UNTRUSTED (#200): we parse it structurally and only ever emit sanitized text — no execution,
  // no fetch, no secrets. No money moves and there are no side effects, so nothing here needs the #13 queue.
  // -------------------------------------------------------------------------------------------------
  app.get("/onboarding/deliverable/stream", async (req, reply) => {
    const business = deriveBusiness((req.query as { url?: string }).url);
    if (!business) {
      return reply.code(400).send({ error: "a website url is required (e.g. acme.com)" });
    }
    reply.hijack();
    writeDeliverableSseHead(reply);
    await streamDeliverable(business, req, reply, activeStreams);
  });

  // -------------------------------------------------------------------------------------------------
  // #610 INSTANT DEMO / SANDBOX: the no-signup sandbox's single-shot feed.
  //
  // The same pure, offline #633 generator as the SSE stream above — but returned as ONE JSON document so
  // a standalone public landing page can fetch it with a plain request and run its own paced reveal. A
  // single GET is far more robust than `EventSource` behind a CDN/proxy (e.g. a Vercel preview that
  // buffers or rate-limits SSE), which matters for a prospect's first impression. Still PUBLIC +
  // UNAUTHENTICATED, deterministic, no DB, no outbound fetch (no SSRF), and no side effects — so nothing
  // here needs the #13 queue. The URL is UNTRUSTED (#200): `deriveBusiness` parses it structurally and we
  // only ever emit sanitized text. 400s (never partial/faked output) when the input isn't a web address.
  app.get("/onboarding/deliverable", async (req, reply) => {
    const business = deriveBusiness((req.query as { url?: string }).url);
    if (!business) {
      return reply.code(400).send({ error: "a website url is required (e.g. acme.com)" });
    }
    return buildDeliverable(business);
  });

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

  // -------------------------------------------------------------------------------------------------
  // #264 DnsManager lanes — automate the three DNS-blocked lanes through the connected provider
  // (Cloudflare, else dry-run) so a non-technical user never edits a record by hand. All gated behind
  // `onboarding.enabled`; none move money; none echo the registrar token (responses are public records).
  // -------------------------------------------------------------------------------------------------

  // Lane 1 — domain ownership verification (Search Console by default). Publishes + verifies the TXT.
  app.post("/me/dns/verify-domain", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as { domain?: unknown; token?: unknown; kind?: unknown };
    const domain = parseDomain(body.domain);
    if (!domain) return reply.code(400).send({ error: "domain is required" });
    if (typeof body.token !== "string" || body.token.trim() === "") {
      return reply.code(400).send({ error: "token is required" });
    }
    return dnsManager.verifyDomain({
      workspaceId: identity.workspaceId,
      domain,
      token: body.token.trim(),
      kind: body.kind === "reload" ? "reload" : "google",
    });
  });

  // Lane 2 — email sender authentication (SPF/DKIM/DMARC) for the connected ESP.
  app.post("/me/dns/email-auth", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as {
      domain?: unknown;
      spfIncludes?: unknown;
      dkim?: unknown;
      dmarcRua?: unknown;
      dmarcPolicy?: unknown;
    };
    const domain = parseDomain(body.domain);
    if (!domain) return reply.code(400).send({ error: "domain is required" });
    return dnsManager.ensureEmailAuth({
      workspaceId: identity.workspaceId,
      domain,
      spfIncludes: parseStringArray(body.spfIncludes),
      dkim: parseDkim(body.dkim),
      dmarcRua: typeof body.dmarcRua === "string" ? body.dmarcRua : undefined,
      dmarcPolicy: parseDmarcPolicy(body.dmarcPolicy),
    });
  });

  // Lane 3 — attach a custom domain to hosted pages (CNAME + CAA for the TLS cert).
  app.post("/me/dns/site-cname", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as {
      domain?: unknown;
      target?: unknown;
      name?: unknown;
      ssl?: unknown;
    };
    const domain = parseDomain(body.domain);
    if (!domain) return reply.code(400).send({ error: "domain is required" });
    if (typeof body.target !== "string" || body.target.trim() === "") {
      return reply.code(400).send({ error: "target is required (the hosting CNAME target)" });
    }
    return dnsManager.ensureSiteCname({
      workspaceId: identity.workspaceId,
      domain,
      target: body.target.trim(),
      name: typeof body.name === "string" ? body.name : undefined,
      ssl: typeof body.ssl === "boolean" ? body.ssl : undefined,
    });
  });

  // One-time "connect a domain" — runs every lane the inputs cover (verification + email + CNAME).
  app.post("/me/dns/setup", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!enabled(identity.workspaceId)) {
      return reply.code(409).send({ error: "onboarding not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as {
      domain?: unknown;
      googleVerificationToken?: unknown;
      reloadVerificationToken?: unknown;
      appTarget?: unknown;
      spfIncludes?: unknown;
      dkim?: unknown;
      dmarcRua?: unknown;
      dmarcPolicy?: unknown;
    };
    const domain = parseDomain(body.domain);
    if (!domain) return reply.code(400).send({ error: "domain is required" });
    return dnsManager.setupDomain({
      workspaceId: identity.workspaceId,
      domain,
      googleVerificationToken:
        typeof body.googleVerificationToken === "string" ? body.googleVerificationToken : undefined,
      reloadVerificationToken:
        typeof body.reloadVerificationToken === "string" ? body.reloadVerificationToken : undefined,
      appTarget: typeof body.appTarget === "string" ? body.appTarget : undefined,
      spfIncludes: parseStringArray(body.spfIncludes),
      dkim: parseDkim(body.dkim),
      dmarcRua: typeof body.dmarcRua === "string" ? body.dmarcRua : undefined,
      dmarcPolicy: parseDmarcPolicy(body.dmarcPolicy),
    });
  });
}

/** Standard SSE response head — disables proxy buffering so frames flush as they are written (#633). */
function writeDeliverableSseHead(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

/**
 * Per-section pacing (ms) for the deliverable stream — the small pause that makes the artifact visibly
 * "appear live" rather than dumping at once. Env-overridable and clamped to a safe 0–2000ms window so even
 * the slowest pacing keeps the whole stream far inside the ~60s budget; tests set it to 0 for instant runs.
 */
function deliverableDelayMs(): number {
  const raw = Number(process.env.ONBOARDING_DELIVERABLE_STREAM_DELAY_MS);
  if (!Number.isFinite(raw)) return 150;
  return Math.max(0, Math.min(2000, Math.trunc(raw)));
}

/**
 * Stream a business's deliverable over an already-hijacked SSE reply: the `start` header, then one
 * `section` frame at a time (paced so it appears live), then `done`. Stops early if the client disconnects
 * or the server shuts down — the timer is always cleared and the socket always ended exactly once.
 */
async function streamDeliverable(
  business: DeliverableBusiness,
  req: FastifyRequest,
  reply: FastifyReply,
  activeStreams: Set<() => void>,
): Promise<void> {
  const res = reply.raw;
  const frames = planToFrames(buildDeliverable(business));
  const delay = deliverableDelayMs();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    activeStreams.delete(stop);
    if (!res.writableEnded) res.end();
  };
  activeStreams.add(stop);
  req.raw.on("close", stop);

  for (const frame of frames) {
    if (stopped) return;
    res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
    if (delay > 0 && frame.event === "section") {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, delay);
      });
    }
  }
  stop();
}

/** Parse + trim a required domain string. Returns null when absent/blank. */
function parseDomain(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Parse a `{selector, publicKey}` DKIM object. Both must be present, string, and non-blank AFTER trimming
 * — otherwise undefined. This stops a blank/whitespace input from producing a malformed record like
 * `._domainkey` or `v=DKIM1; k=rsa; p=` that would fail or pollute the zone.
 */
export function parseDkim(value: unknown): { selector: string; publicKey: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const d = value as { selector?: unknown; publicKey?: unknown };
  if (typeof d.selector !== "string" || typeof d.publicKey !== "string") return undefined;
  const selector = d.selector.trim();
  const publicKey = d.publicKey.trim();
  return selector !== "" && publicKey !== "" ? { selector, publicKey } : undefined;
}

/**
 * Parse a string[] body field: keep strings only, trim each, and drop blanks — so an empty SPF include
 * can't yield an invalid record like `v=spf1 include: ~all`. Returns undefined when not an array.
 */
export function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : undefined;
}

/** Parse a DMARC policy enum body field. Returns undefined for anything else (builder defaults to none). */
function parseDmarcPolicy(value: unknown): "none" | "quarantine" | "reject" | undefined {
  return value === "none" || value === "quarantine" || value === "reject" ? value : undefined;
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
