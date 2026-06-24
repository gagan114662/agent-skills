import { loadConfig } from "../config/loader.js";
import { dryRunEspSender, type EspSender } from "../reach/channels/email.js";
import type { ReachService } from "../reach/service.js";
import type { SanitizedLead } from "./inbound.js";

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

export interface InboundLeadFollowupInput {
  workspaceId: string;
  leadId: string;
  lead: SanitizedLead;
}

export interface InboundLeadFollowup {
  handle(input: InboundLeadFollowupInput): Promise<void>;
}

export interface InboundLeadConfirmationSender {
  send(input: {
    to: string;
    name: string | null;
    confirmationUrl: string;
  }): Promise<void>;
}

function domainCompany(email: string): { company: string; companyDomain: string } {
  const domain = email.split("@")[1]?.trim().toLowerCase() || "inbound.local";
  const label = domain.split(".")[0] || "Inbound lead";
  return { company: label, companyDomain: domain };
}

function fallbackName(email: string): string {
  const local = email.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  return local || "Inbound lead";
}

/**
 * Convert a captured warm hand-raise into the Reach loop. Import is idempotent by email contact key; the
 * batch then composes/sends/enrols under normal Reach caps, suppression, footer, and sender rules.
 */
export function createDefaultInboundLeadFollowup(
  reach: Pick<ReachService, "importProspects" | "runBatch">,
): InboundLeadFollowup {
  return {
    async handle({ workspaceId, lead }) {
      const { company, companyDomain } = domainCompany(lead.email);
      await reach.importProspects(workspaceId, [{
        fullName: lead.name ?? fallbackName(lead.email),
        title: "Inbound lead",
        company,
        companyDomain,
        email: lead.email,
        industry: null,
        companySize: null,
        signalKind: "content_engagement",
        signalSummary: `Inbound form (${lead.source}): ${lead.message}`,
        observedAtMs: Date.now(),
      }]);
      await reach.runBatch(workspaceId);
    },
  };
}

/**
 * Send the verification email through the repo's existing ESP seam. The default remains dry-run/no-network
 * until a deployment supplies a live sender, but the route still exercises a real confirmation-send path.
 */
export function createDefaultInboundLeadConfirmationSender(
  sender: EspSender = dryRunEspSender,
): InboundLeadConfirmationSender {
  return {
    async send({ to, name, confirmationUrl }) {
      const displayName = name?.trim();
      const greeting = displayName ? "Hi " + displayName + "," : "Hi,";
      await sender.send({
        to,
        subject: "Confirm your ipop.ai request",
        body: [
          greeting,
          "",
          "Please confirm this email address so the ipop.ai team can follow up on your request:",
          confirmationUrl,
          "",
          "If you did not submit the form, you can ignore this email.",
        ].join("\n"),
      });
    },
  };
}
