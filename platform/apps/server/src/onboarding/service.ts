import {
  decideSetupNeeded,
  decideCapabilityStates,
  decideRotationReminders,
} from "./decide.js";
import { planDomainRecords, type DnsPlanInput } from "./dns/records.js";
import { summarizeReceipts, type DnsProvider } from "./dns/provider.js";
import type { OnboardingCaps } from "./caps.js";
import type {
  CapabilityDependency,
  CapabilityState,
  RequiredService,
  RotationReminder,
  SetupRequestSpec,
  SetupRequestStatus,
} from "./types.js";
import type { SetupRequestRow } from "../db/repositories/setup-requests.js";
import type { ServiceCredentialRow } from "../db/repositories/external-credentials.js";
import type { DnsReceiptRow } from "../db/repositories/dns-receipts.js";

/**
 * External account onboarding orchestrator (#192, ADR-0192). Composes the pure decide core with injected
 * IO seams (the three repos, the #13 approval gate, the DNS provider, the config caps, a clock) so the
 * two real flows — "file blocked setup into the decision queue" and "configure + verify DNS with
 * receipts" — are unit-tested with fakes. `default.ts` wires the seams to the real repos. The service
 * never reads a secret back: connecting takes a plain map in and returns status only.
 */

export interface SetupRequestStore {
  upsert(input: {
    workspaceId: string;
    serviceKey: string;
    serviceKind: SetupRequestSpec["serviceKind"];
    displayName: string;
    plan: string | null;
    scopes: string[];
    reason: string;
    projectedCostCents: number;
    reversibility: SetupRequestSpec["reversibility"];
    approvalRequestId?: string | null;
    requestedByMemberId?: string | null;
  }): Promise<SetupRequestRow>;
  list(workspaceId: string): Promise<SetupRequestRow[]>;
  setStatus(workspaceId: string, serviceKey: string, status: SetupRequestStatus): Promise<void>;
}

export interface CredentialStore {
  set(input: {
    workspaceId: string;
    serviceKey: string;
    secrets: Record<string, string>;
    scopes?: string[];
    rotationReminderDays?: number;
    connectedByMemberId?: string | null;
  }): Promise<ServiceCredentialRow>;
  list(workspaceId: string): Promise<ServiceCredentialRow[]>;
  revoke(workspaceId: string, serviceKey: string): Promise<void>;
}

export interface DnsReceiptStore {
  record(input: {
    workspaceId: string;
    domain: string;
    provider: string;
    receipts: Awaited<ReturnType<DnsProvider["configure"]>>["receipts"];
  }): Promise<void>;
  list(workspaceId: string, domain?: string): Promise<DnsReceiptRow[]>;
}

/** The #13 approval gate (a blocked setup parks here). Mirrors the portfolio-sunset gate seam. Under #243
 * the gate is kind-aware: only a MONEY connect (live payment credentials) parks an owner approval. */
export interface OnboardingApprovalGate {
  requiresApproval(workspaceId: string, serviceKind: SetupRequestSpec["serviceKind"]): Promise<boolean>;
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface OnboardingDeps {
  setupRequests: SetupRequestStore;
  credentials: CredentialStore;
  dnsReceipts: DnsReceiptStore;
  approvals: OnboardingApprovalGate;
  dns: DnsProvider;
  resolveCaps: (workspaceId: string) => OnboardingCaps;
  now: () => number;
}

/** One filed setup request + the #13 approval that parks it. */
export interface FiledSetup {
  spec: SetupRequestSpec;
  requestId: string;
  approvalRequestId: string | null;
}

/** The guided checklist the console + Slack render (acceptance 2/5). */
export interface OnboardingChecklist {
  requests: Array<{
    serviceKey: string;
    displayName: string;
    serviceKind: string;
    plan: string | null;
    reason: string;
    projectedCostCents: number;
    reversibility: string;
    requiresHuman: boolean;
    status: SetupRequestStatus;
    connected: boolean;
    approvalRequestId: string | null;
  }>;
  rotationReminders: RotationReminder[];
  capabilities: CapabilityState[];
  /** Count of services still awaiting the owner. */
  pendingSetupCount: number;
}

export class OnboardingService {
  constructor(private readonly deps: OnboardingDeps) {}

  /**
   * Needs detection (acceptance 1) + park (acceptance 5). For each required service NOT already connected,
   * upsert a setup request and — when the #13 policy gates it (sensitive by default) — submit a PENDING
   * approval so the blocked work ages visibly in the decision queue. Idempotent: re-filing an already-open
   * request updates it in place and does not stack a second approval.
   */
  async fileSetupNeeds(input: {
    workspaceId: string;
    required: RequiredService[];
    requesterMemberId: string;
  }): Promise<FiledSetup[]> {
    const connected = new Set(
      (await this.deps.credentials.list(input.workspaceId))
        .filter((c) => c.connected)
        .map((c) => c.serviceKey),
    );
    const specs = decideSetupNeeded(input.required, connected);
    const existing = new Map(
      (await this.deps.setupRequests.list(input.workspaceId)).map((r) => [r.serviceKey, r]),
    );
    const filed: FiledSetup[] = [];
    for (const spec of specs) {
      // Reuse an already-linked approval (idempotent re-file); otherwise submit one when the policy gates.
      // Under #243 the gate is per-kind: only a MONEY connect (live payment credentials) parks an approval.
      let approvalRequestId = existing.get(spec.serviceKey)?.approvalRequestId ?? null;
      const gated = await this.deps.approvals.requiresApproval(input.workspaceId, spec.serviceKind);
      if (!approvalRequestId && gated) {
        const approval = await this.deps.approvals.submit({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          summary: spec.summary,
          payload: {
            source: "onboarding",
            serviceKey: spec.serviceKey,
            serviceKind: spec.serviceKind,
            plan: spec.plan,
            projectedCostCents: spec.projectedCostCents,
            reversibility: spec.reversibility,
          },
        });
        approvalRequestId = approval.id;
      }
      const row = await this.deps.setupRequests.upsert({
        workspaceId: input.workspaceId,
        serviceKey: spec.serviceKey,
        serviceKind: spec.serviceKind,
        displayName: spec.displayName,
        plan: spec.plan,
        scopes: spec.scopes,
        reason: spec.reason,
        projectedCostCents: spec.projectedCostCents,
        reversibility: spec.reversibility,
        approvalRequestId,
        requestedByMemberId: input.requesterMemberId,
      });
      filed.push({ spec, requestId: row.id, approvalRequestId });
    }
    return filed;
  }

  /**
   * Connect (or re-connect) a service's credentials (acceptance 2). Seals the pasted map (write-only),
   * applies the default rotation reminder when the caller omits one, and flips the setup request to
   * `connected`. Returns the status only — never the secrets.
   */
  async connect(input: {
    workspaceId: string;
    serviceKey: string;
    secrets: Record<string, string>;
    scopes?: string[];
    rotationReminderDays?: number;
    connectedByMemberId?: string | null;
  }): Promise<ServiceCredentialRow> {
    const caps = this.deps.resolveCaps(input.workspaceId);
    const status = await this.deps.credentials.set({
      ...input,
      rotationReminderDays: input.rotationReminderDays ?? caps.defaultRotationDays,
    });
    await this.deps.setupRequests.setStatus(input.workspaceId, input.serviceKey, "connected");
    return status;
  }

  /**
   * Revoke a service (acceptance 4). Marks the credential revoked (dependent capabilities go offline
   * gracefully via {@link checklist}) and reopens its setup request so the checklist shows it needs
   * re-connection. Idempotent.
   */
  async revoke(workspaceId: string, serviceKey: string): Promise<void> {
    await this.deps.credentials.revoke(workspaceId, serviceKey);
    await this.deps.setupRequests.setStatus(workspaceId, serviceKey, "requested");
  }

  /** The guided checklist (acceptance 2/5): requests + connection state + rotation reminders + capabilities. */
  async checklist(
    workspaceId: string,
    capabilityDeps: CapabilityDependency[] = [],
  ): Promise<OnboardingChecklist> {
    const [requests, creds] = await Promise.all([
      this.deps.setupRequests.list(workspaceId),
      this.deps.credentials.list(workspaceId),
    ]);
    const connectedSet = new Set(creds.filter((c) => c.connected).map((c) => c.serviceKey));
    const rotationReminders = decideRotationReminders(
      creds
        .filter((c) => c.connected)
        .map((c) => ({
          serviceKey: c.serviceKey,
          connectedAtMs: c.connectedAtMs,
          rotationReminderDays: c.rotationReminderDays,
        })),
      this.deps.now(),
    );
    const capabilities = decideCapabilityStates(capabilityDeps, connectedSet);
    const requestViews = requests.map((r) => ({
      serviceKey: r.serviceKey,
      displayName: r.displayName,
      serviceKind: r.serviceKind,
      plan: r.plan,
      reason: r.reason,
      projectedCostCents: r.projectedCostCents,
      reversibility: r.reversibility,
      requiresHuman: true,
      status: r.status,
      connected: connectedSet.has(r.serviceKey),
      approvalRequestId: r.approvalRequestId,
    }));
    return {
      requests: requestViews,
      rotationReminders,
      capabilities,
      pendingSetupCount: requestViews.filter((r) => !r.connected && r.status !== "dismissed").length,
    };
  }

  /**
   * Configure + verify a domain's DNS / SSL / email-auth records autonomously (acceptance 3) — the
   * REVERSIBLE half the agent does after the owner buys the domain (the money step). Plans the records,
   * configures them, records a receipt per record, then verifies (the reality-touching step) and records
   * the verified receipts. Returns the verified outcome + a roll-up summary.
   */
  async configureDns(input: {
    workspaceId: string;
    plan: DnsPlanInput;
    onLog?: (line: string) => void;
  }): Promise<{
    domain: string;
    provider: string;
    receipts: Awaited<ReturnType<DnsProvider["verify"]>>["receipts"];
    summary: ReturnType<typeof summarizeReceipts>;
  }> {
    const records = planDomainRecords(input.plan);
    const configured = await this.deps.dns.configure({
      domain: input.plan.domain,
      records,
      onLog: input.onLog,
    });
    await this.deps.dnsReceipts.record({
      workspaceId: input.workspaceId,
      domain: configured.domain,
      provider: configured.provider,
      receipts: configured.receipts,
    });
    const verified = await this.deps.dns.verify({
      domain: input.plan.domain,
      records,
      onLog: input.onLog,
    });
    await this.deps.dnsReceipts.record({
      workspaceId: input.workspaceId,
      domain: verified.domain,
      provider: verified.provider,
      receipts: verified.receipts,
    });
    return {
      domain: verified.domain,
      provider: verified.provider,
      receipts: verified.receipts,
      summary: summarizeReceipts(verified.receipts),
    };
  }
}
