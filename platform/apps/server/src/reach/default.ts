import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config/loader.js";
import { resolveSiteUrl } from "../marketing/site.js";
import { createRequest, listRequests } from "../db/repositories/approvals.js";
import { getPersonaByHandle } from "../db/repositories/personas.js";
import { listDnsReceipts } from "../db/repositories/dns-receipts.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import type { SenderAuthInput } from "../email/deliverability.js";
import { dbSuppressionStore } from "../db/repositories/acquisition.js";
import { resolvePostmarkSender } from "../email/postmark-provider.js";
import {
  dbReachContactStore,
  dbReachReceiptStore,
  dbReachRunStore,
  dbReachSendStore,
} from "../db/repositories/reach.js";
import { REACH_DATA_CREDIT_ACTION } from "../approvals/policy.js";
import { resolveReachCaps, isOwnerWorkspace } from "./caps.js";
import { createEmailChannel } from "./channels/email.js";
import { dryRunEspSender, type EspSender } from "./channels/email.js";
import { createLinkedInChannel, type LinkedInSender } from "./channels/linkedin.js";
import { createLinkedInApiSender } from "./channels/linkedin-api.js";
import { createProspectSource, type HttpFetch } from "./sources/index.js";
import { ReachService, type ReachDeps } from "./service.js";

/** The Reach department lead's @handle — the persona that owns the channel + is the money-gate requester. */
export const REACH_AGENT_HANDLE = "comet";
const POSTMARK_SERVICE_KEY = "postmark";
const POSTMARK_TOKEN_KEY = "POSTMARK_SERVER_TOKEN";
const POSTMARK_FROM_KEYS = ["POSTMARK_FROM", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER"] as const;
const POSTMARK_AUTH_RESULTS_HEADER_KEY = "POSTMARK_AUTH_RESULTS_HEADER";
const LINKEDIN_SERVICE_KEY = "linkedin";
const LINKEDIN_TOKEN_KEYS = ["LINKEDIN_API_TOKEN", "LINKEDIN_ACCESS_TOKEN"] as const;
const LINKEDIN_BASE_URL_KEY = "LINKEDIN_API_BASE_URL";

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

function firstSecret(secrets: Record<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = secrets[key]?.trim();
    if (value) return value;
  }
  return "";
}

function senderDomain(secrets: Record<string, string>): string {
  const from = firstSecret(secrets, POSTMARK_FROM_KEYS);
  const domain = from.split("@")[1]?.trim().toLowerCase() ?? "";
  return domain.replace(/^www\./, "");
}

async function resolveReachDeliverabilityProof(workspaceId: string): Promise<{
  auth: SenderAuthInput;
  authResultsHeader?: string | null;
} | null> {
  const caps = resolveReachCaps(loadConfig(workspaceId).reach);
  if (caps.sendProvider !== "postmark" || !caps.liveSendEnabled) return null;
  const secrets = await resolveServiceSecrets(workspaceId, POSTMARK_SERVICE_KEY);
  const domain = caps.sendingDomains.find((d) => d.enabled)?.domain ?? senderDomain(secrets);
  if (!domain) return null;
  const receipts = await listDnsReceipts(workspaceId, domain);
  const verified = (purpose: "spf" | "dkim" | "dmarc") =>
    receipts.find((r) => r.purpose === purpose && r.status === "verified");
  const spf = verified("spf");
  const dkim = verified("dkim");
  const dmarc = verified("dmarc");
  return {
    auth: {
      spf: spf ? { published: true, includesEsp: /include:/i.test(spf.value) } : undefined,
      dkim: dkim ? { published: true, verified: true } : undefined,
      dmarc: dmarc
        ? {
            published: true,
            policy: /p=reject\b/i.test(dmarc.value)
              ? "reject"
              : /p=quarantine\b/i.test(dmarc.value)
                ? "quarantine"
                : "none",
          }
        : undefined,
    },
    authResultsHeader: secrets[POSTMARK_AUTH_RESULTS_HEADER_KEY]?.trim() || null,
  };
}

export function resolveReachPostmarkSender(input: {
  caps: ReturnType<typeof resolveReachCaps>;
  secrets: Record<string, string>;
}): EspSender {
  if (input.caps.sendProvider !== "postmark" || !input.caps.liveSendEnabled) return dryRunEspSender;
  const fallbackFrom = input.caps.sendingDomains.find((d) => d.enabled)?.from ?? "";
  return resolvePostmarkSender({
    live: true,
    serverToken: firstSecret(input.secrets, [POSTMARK_TOKEN_KEY]),
    from: firstSecret(input.secrets, POSTMARK_FROM_KEYS) || fallbackFrom,
  });
}

async function resolveReachEmailSender(workspaceId: string): Promise<EspSender> {
  const caps = resolveReachCaps(loadConfig(workspaceId).reach);
  if (caps.sendProvider !== "postmark" || !caps.liveSendEnabled) return dryRunEspSender;
  const secrets = await resolveServiceSecrets(workspaceId, POSTMARK_SERVICE_KEY);
  return resolveReachPostmarkSender({ caps, secrets });
}

export function resolveReachLinkedInSender(input: {
  caps: ReturnType<typeof resolveReachCaps>;
  secrets: Record<string, string>;
}): LinkedInSender | undefined {
  if (input.caps.linkedinSendProvider !== "api" || !input.caps.linkedinLiveSendEnabled) {
    return undefined;
  }
  const token = firstSecret(input.secrets, LINKEDIN_TOKEN_KEYS);
  const baseUrl = input.secrets[LINKEDIN_BASE_URL_KEY]?.trim() ?? "";
  if (!token || !baseUrl) return undefined;
  return createLinkedInApiSender({ token, baseUrl });
}

async function resolveReachLiveChannelHealth(workspaceId: string): Promise<readonly string[]> {
  const caps = resolveReachCaps(loadConfig(workspaceId).reach);
  const reasons: string[] = [];
  const emailClaimsLive = caps.sendProvider !== "dryrun" && caps.liveSendEnabled;
  if (emailClaimsLive) {
    const sender = await resolveReachEmailSender(workspaceId);
    if (sender.kind === dryRunEspSender.kind) {
      reasons.push("email sender is dry-run (missing live ESP credentials)");
    }
    const proof = await resolveReachDeliverabilityProof(workspaceId);
    if (!proof) {
      reasons.push("email deliverability not confirmed");
    }
  }
  const linkedinClaimsLive =
    caps.linkedinSendProvider !== "none" && caps.linkedinLiveSendEnabled;
  if (linkedinClaimsLive) {
    const sender = await resolveReachLinkedInSenderForWorkspace(workspaceId);
    if (!sender) {
      reasons.push("LinkedIn sender is queue-only (missing permitted API credentials)");
    }
  }
  return reasons;
}

async function resolveReachLinkedInSenderForWorkspace(
  workspaceId: string,
): Promise<LinkedInSender | undefined> {
  const caps = resolveReachCaps(loadConfig(workspaceId).reach);
  if (caps.linkedinSendProvider !== "api" || !caps.linkedinLiveSendEnabled) return undefined;
  const secrets = await resolveServiceSecrets(workspaceId, LINKEDIN_SERVICE_KEY);
  return resolveReachLinkedInSender({ caps, secrets });
}

/**
 * Wire the production {@link ReachService} (#280). Default-OFF + `imported` source + `dryrun` email sender, so
 * a deployment that sets nothing spends nothing, fabricates nothing, and sends nothing. The email channel resolves a tenant-scoped
 * Postmark sender only when Reach live send is explicitly enabled and the #192 vault has the token + From;
 * LinkedIn queues (no permitted send path wired). The paid sources resolve their key from the #192 vault
 * and never log it. LinkedIn stays queue-only unless a workspace explicitly opts into the permitted API
 * sender and connects its #192 `linkedin` vault token + API base URL; it never drives the LinkedIn UI.
 */
export function createDefaultReachService(log?: FastifyBaseLogger): ReachService {
  const channels: ReachDeps["channels"] = {
    // Email stays recorded-only unless the workspace explicitly opts Reach into Postmark and connects #192
    // vault credentials; LinkedIn remains queue-only without a permitted API sender.
    email: createEmailChannel({ resolveSender: (ctx) => resolveReachEmailSender(ctx.workspaceId) }),
    linkedin: createLinkedInChannel({
      resolveSender: (ctx) => resolveReachLinkedInSenderForWorkspace(ctx.workspaceId),
    }),
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
      createProspectSource(
        kind,
        {
          httpFetch: realHttpFetch,
          loadImportedProspects: (input) =>
            dbReachContactStore.importedProspects(
              input.workspaceId,
              input.limit,
              input.excludeKeys,
            ),
          loadApiKey: async (serviceKey, envKey) => {
            const secrets = await resolveServiceSecrets(workspaceId, serviceKey);
            return secrets[envKey] ?? null;
          },
        },
        workspaceId,
      ),
    channels,
    contacts: dbReachContactStore,
    sends: dbReachSendStore,
    receipts: dbReachReceiptStore,
    runs: dbReachRunStore,
    suppressions: {
      loadSuppressed: (workspaceId) => dbSuppressionStore.loadSuppressed(workspaceId),
    },
    deliverability: { proof: resolveReachDeliverabilityProof },
    liveChannelHealth: resolveReachLiveChannelHealth,
    approvals: {
      async dataCreditSpend(workspaceId, provider) {
        const requests = (
          await Promise.all([
            listRequests(workspaceId, { status: "pending", limit: 500 }),
            listRequests(workspaceId, { status: "approved", limit: 500 }),
            listRequests(workspaceId, { status: "executed", limit: 500 }),
          ])
        ).flat();
        let pendingCents = 0;
        let approvedCents = 0;
        let pendingRequestId: string | null = null;
        for (const req of requests) {
          if (req.actionType !== REACH_DATA_CREDIT_ACTION) continue;
          if (req.payload.provider !== provider) continue;
          const amount =
            typeof req.amount === "number" && Number.isFinite(req.amount) ? req.amount : 0;
          if (req.status === "pending") {
            pendingCents += amount;
            pendingRequestId ??= req.id;
          } else {
            approvedCents += amount;
          }
        }
        return { pendingCents, approvedCents, pendingRequestId };
      },
      async submitDataCreditSpend(input) {
        // The Reach lead persona is the requester for the autonomous money gate (an agent member, never a
        // human) — consistent with how the monetization / outreach money actions are parked.
        const persona = await getPersonaByHandle(input.workspaceId, REACH_AGENT_HANDLE);
        if (!persona) {
          throw new Error(
            `reach persona @${REACH_AGENT_HANDLE} not found — seed the department before enabling a paid source`,
          );
        }
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: persona.agentMemberId,
          actionType: REACH_DATA_CREDIT_ACTION,
          payload: {
            provider: input.provider,
            amountCents: input.amountCents,
            prospectCount: input.prospectCount,
          },
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
