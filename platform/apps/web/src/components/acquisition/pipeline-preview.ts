export type SourceStatus = "ready" | "blocked";

export interface PipelineSource {
  readonly name: string;
  readonly category: string;
  readonly status: SourceStatus;
  readonly receipt: string;
}

export interface ProspectRow {
  readonly account: string;
  readonly fit: string;
  readonly evidence: string;
  readonly receipt: string;
}

export interface AcquisitionPipelinePreview {
  readonly domain: string;
  readonly icp: string;
  readonly interpretation: string;
  readonly sources: readonly PipelineSource[];
  readonly prospects: readonly ProspectRow[];
  readonly verification: {
    readonly status: "blocked" | "ready";
    readonly label: string;
    readonly receipt: string;
  };
  readonly outreach: {
    readonly status: "approval_required";
    readonly draft: string;
    readonly receipt: string;
  };
  readonly capacity: readonly string[];
  readonly nextAction: {
    readonly label: string;
    readonly gated: true;
  };
}

export interface AcquisitionPreviewInput {
  readonly domain: string;
  readonly icp: string;
  readonly sourcesEnabled?: boolean;
}

function clean(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : fallback;
}

function hostFromDomain(value: string): string {
  const raw = clean(value, "your company");
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || raw;
  }
}

export function buildAcquisitionPipelinePreview(
  input: AcquisitionPreviewInput,
): AcquisitionPipelinePreview {
  const domain = hostFromDomain(input.domain);
  const icp = clean(input.icp, "your best-fit customers");
  const sourcesEnabled = input.sourcesEnabled === true;

  const sources: PipelineSource[] = [
    { name: "Website", category: "Owned site", status: "ready", receipt: `domain.normalized:${domain}` },
    { name: "LinkedIn", category: "Account research", status: "blocked", receipt: "connector.linkedin:not_connected" },
    { name: "Google Maps", category: "Local/company discovery", status: "blocked", receipt: "connector.google_maps:not_connected" },
    { name: "Job boards", category: "Hiring-intent signals", status: "blocked", receipt: "connector.job_boards:not_connected" },
    { name: "Contact enrichment", category: "Email/phone verification", status: "blocked", receipt: "provider.contact_data:not_configured" },
  ];

  return {
    domain,
    icp,
    interpretation: `Find ${icp} for ${domain}, verify why they fit, then draft outreach for approval before anything leaves ipop.`,
    sources,
    prospects: sourcesEnabled
      ? [
          {
            account: domain,
            fit: "Owned-domain seed account",
            evidence: "Only the submitted website is available in this preview.",
            receipt: `prospect.seed:${domain}`,
          },
        ]
      : [],
    verification: {
      status: sourcesEnabled ? "ready" : "blocked",
      label: sourcesEnabled
        ? "Seed account verified from the submitted domain."
        : "No external prospect source is connected yet, so ipop is not inventing leads.",
      receipt: sourcesEnabled ? `verification.seed:${domain}` : "verification.blocked:no_external_sources",
    },
    outreach: {
      status: "approval_required",
      draft: `Draft a first-touch note for ${icp}; hold every send for approval until an outbound channel is connected and approved.`,
      receipt: "outreach.policy:approval_required",
    },
    capacity: [
      "prospect rows only from connected sources",
      "channels stay gated until connected",
      "every outbound batch needs approval",
      "agent runs stay inside the workspace cap",
    ],
    nextAction: {
      label: "Connect a prospect source, then approve the first outreach batch.",
      gated: true,
    },
  };
}
