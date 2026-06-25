import type { ReachConfig } from "../config/schema.js";
import { isProspectSourceKind, type ProspectSourceKind } from "./types.js";

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
  /** Per-sending-domain daily send ceiling (deliverability bound). */
  perDomainDailyCap: number;
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
  perDomainDailyCap: 50,
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

export function resolveReachCaps(cfg: ReachConfig | undefined): ReachCaps {
  const source = cfg?.prospectSource;
  return {
    enabled: cfg?.enabled ?? REACH_DEFAULTS.enabled,
    prospectSource: source && isProspectSourceKind(source) ? source : REACH_DEFAULTS.prospectSource,
    sendProvider: cfg?.sendProvider ?? REACH_DEFAULTS.sendProvider,
    liveSendEnabled: cfg?.liveSendEnabled ?? REACH_DEFAULTS.liveSendEnabled,
    perDomainDailyCap: positiveIntOr(cfg?.perDomainDailyCap, REACH_DEFAULTS.perDomainDailyCap),
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
