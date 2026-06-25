import type { ReachConfig } from "../config/schema.js";
import { isProspectSourceKind, type ProspectSourceKind } from "./types.js";

export interface ReachSendingDomain {
  from: string;
  domain: string;
  dailyCap: number;
  enabled: boolean;
}

/**
 * Resolved Reach policy (#280). Fills the hard defaults the config partial omits. Default OFF + `imported`
 * source + `dryrun` sender, so an un-configured workspace spends nothing and never fabricates prospects.
 * `perDomainDailyCap` is the deliverability bound that makes the autonomous email send
 * safe (premortem #200 §4); `batchSize` caps how many prospects one cron run processes. The footer fields
 * supply the CAN-SPAM/GDPR footer enforced in code on every email.
 */
export interface ReachCaps {
  enabled: boolean;
  /** Which prospect data provider to use. A paid one makes prospect search a money-gated action. */
  prospectSource: ProspectSourceKind;
  /** Email sender kind (`dryrun` = recorded-only, no network). */
  sendProvider: string;
  /** Whether Reach may resolve a real ESP sender. Default OFF; dry-run remains byte-for-byte default. */
  liveSendEnabled: boolean;
  /** LinkedIn sender kind. `none` means queue-only; `api` resolves a permitted API sender. */
  linkedinSendProvider: string;
  /** Whether Reach may resolve a real LinkedIn sender. Default OFF; queue-only remains default. */
  linkedinLiveSendEnabled: boolean;
  /** Per-sending-domain daily send ceiling (deliverability bound). */
  perDomainDailyCap: number;
  /** Optional sender pool. Empty preserves the legacy single-domain path. */
  sendingDomains: ReachSendingDomain[];
  /** Pause email sends when recent bounces exceed this rate over sent messages. */
  maxBounceRate: number;
  /** Pause email sends when recent complaints exceed this rate over sent messages. */
  maxComplaintRate: number;
  /** Workspace-level hard cap for paid prospect-data credits. Zero means no paid data credits. */
  dataCreditBudgetCents: number;
  /** Max prospects sourced + processed per cron batch. */
  batchSize: number;
  /** The owner's own workspace id (owner-first rollout marker), or null. */
  ownerWorkspaceId: string | null;
  brandName: string | null;
  postalAddress: string | null;
  unsubscribeUrl: string | null;
}

export const REACH_DEFAULTS: ReachCaps = {
  enabled: false,
  prospectSource: "imported",
  sendProvider: "dryrun",
  liveSendEnabled: false,
  linkedinSendProvider: "none",
  linkedinLiveSendEnabled: false,
  perDomainDailyCap: 50,
  sendingDomains: [],
  maxBounceRate: 0.05,
  maxComplaintRate: 0.001,
  dataCreditBudgetCents: 0,
  batchSize: 25,
  ownerWorkspaceId: null,
  brandName: null,
  postalAddress: null,
  unsubscribeUrl: null,
};

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function nonnegativeIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function domainOf(from: string): string {
  const domain = from.split("@")[1]?.trim().toLowerCase() ?? "";
  return domain.replace(/^www\./, "");
}

function normalizeSendingDomains(cfg: ReachConfig | undefined, fallbackCap: number): ReachSendingDomain[] {
  const seen = new Set<string>();
  return (cfg?.sendingDomains ?? []).flatMap((entry) => {
    const from = entry.from?.trim();
    if (!from) return [];
    const domain = domainOf(from);
    if (!domain || seen.has(domain)) return [];
    seen.add(domain);
    return [{
      from,
      domain,
      dailyCap: positiveIntOr(entry.dailyCap, fallbackCap),
      enabled: entry.enabled ?? true,
    }];
  });
}

export function resolveReachCaps(cfg: ReachConfig | undefined): ReachCaps {
  const source = cfg?.prospectSource;
  const perDomainDailyCap = positiveIntOr(cfg?.perDomainDailyCap, REACH_DEFAULTS.perDomainDailyCap);
  return {
    enabled: cfg?.enabled ?? REACH_DEFAULTS.enabled,
    prospectSource: source && isProspectSourceKind(source) ? source : REACH_DEFAULTS.prospectSource,
    sendProvider: cfg?.sendProvider ?? REACH_DEFAULTS.sendProvider,
    liveSendEnabled: cfg?.liveSendEnabled ?? REACH_DEFAULTS.liveSendEnabled,
    linkedinSendProvider: cfg?.linkedinSendProvider ?? REACH_DEFAULTS.linkedinSendProvider,
    linkedinLiveSendEnabled:
      cfg?.linkedinLiveSendEnabled ?? REACH_DEFAULTS.linkedinLiveSendEnabled,
    perDomainDailyCap,
    sendingDomains: normalizeSendingDomains(cfg, perDomainDailyCap),
    maxBounceRate:
      typeof cfg?.maxBounceRate === "number" && Number.isFinite(cfg.maxBounceRate) && cfg.maxBounceRate >= 0
        ? cfg.maxBounceRate
        : REACH_DEFAULTS.maxBounceRate,
    maxComplaintRate:
      typeof cfg?.maxComplaintRate === "number" &&
      Number.isFinite(cfg.maxComplaintRate) &&
      cfg.maxComplaintRate >= 0
        ? cfg.maxComplaintRate
        : REACH_DEFAULTS.maxComplaintRate,
    dataCreditBudgetCents: nonnegativeIntOr(
      cfg?.dataCreditBudgetCents,
      REACH_DEFAULTS.dataCreditBudgetCents,
    ),
    batchSize: positiveIntOr(cfg?.batchSize, REACH_DEFAULTS.batchSize),
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? REACH_DEFAULTS.ownerWorkspaceId,
    brandName: cfg?.brandName ?? REACH_DEFAULTS.brandName,
    postalAddress: cfg?.postalAddress ?? REACH_DEFAULTS.postalAddress,
    unsubscribeUrl: cfg?.unsubscribeUrl ?? REACH_DEFAULTS.unsubscribeUrl,
  };
}

/** True iff this is the owner's own workspace (owner-first rollout). */
export function isOwnerWorkspace(caps: ReachCaps, workspaceId: string): boolean {
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
