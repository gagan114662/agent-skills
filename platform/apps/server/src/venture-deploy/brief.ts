import type { ReleaseReceipt } from "./types.js";

/**
 * The venture-deploy slice of the daily founder brief (#195 AC4). A pure roll-up of the release receipts
 * in the window: how many ventures shipped to prod, how many rolled back (a broken image caught before
 * customers), how many need the owner (a gated prod cutover or a failed release escalation), and how many
 * incidents the releases auto-filed. OPTIONAL in the brief — when absent the brief renders exactly as
 * before (the #189 acquisition precedent).
 */
export interface VentureDeployBriefView {
  /** Total release attempts in the window. */
  total: number;
  /** Releases promoted to production (smoke-green cutovers). */
  promoted: number;
  /** Releases auto-rolled-back (a broken image kept off customers, #195 AC3). */
  rolledBack: number;
  /** Releases parked for the owner — a gated prod cutover or a failed-release escalation. */
  needsOwner: number;
  /** Self-healing incidents auto-filed from failed releases. */
  incidents: number;
}

/** Pure roll-up of release receipts into the brief view. Same input → same view. */
export function summarizeReleasesForBrief(receipts: ReleaseReceipt[]): VentureDeployBriefView {
  let promoted = 0;
  let rolledBack = 0;
  let needsOwner = 0;
  let incidents = 0;
  for (const r of receipts) {
    if (r.status === "promoted") promoted += 1;
    else if (r.status === "rolled_back") rolledBack += 1;
    else needsOwner += 1; // escalated | deploy_failed | smoke_failed all need the owner
    if (r.incidentFiled) incidents += 1;
  }
  return { total: receipts.length, promoted, rolledBack, needsOwner, incidents };
}
