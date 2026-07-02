/**
 * CMO top-summary resolver (#1456) — the <10-second business readout at the very top of the dashboard.
 *
 * The hard rule from the #200 premortem (§2 "self-reported metrics are fiction; only external receipts"):
 * a fresh workspace must NEVER render a fabricated number. Every one of the six CMO questions resolves to an
 * explicit, honest provenance:
 *
 *   · "receipt"        — backed by a real, internally- or externally-verifiable receipt (the approval queue,
 *                        the connector catalog, or a shipped-artifact receipt link). Real numbers only.
 *   · "not_connected"  — no source is wired. We show "connect X to track", NOT a fake "0".
 *   · "blocked"        — a connector is blocked, or the metric lives behind an owner-gated capability (money).
 *                        Rendered as "blocked — needs owner" (#200 §4: irreversible/money stays human-gated).
 *
 * This module is PURE and deterministic so every branch is unit-tested without a DOM. It reads ONLY the real
 * seams the dashboard already gathers (approvals, connector catalog, transparency receipts) — it pulls no new
 * data, holds no credentials, and sends nothing. Connector-supplied text is untrusted DATA (#200 §6): the
 * provenance logic keys ONLY off structural enums (group/status), never off free-text the connector controls.
 */

import type { ApprovalCard, EverydayConnector, ExternalAction } from "./everyday-data";

/** The six questions a CMO asks, in scan order. */
export const CMO_SUMMARY_KEYS = ["pipeline", "leads", "shipped", "revenue", "approvals", "channels"] as const;
export type CmoSummaryKey = (typeof CMO_SUMMARY_KEYS)[number];

export type CmoMetricProvenance = "receipt" | "not_connected" | "blocked";

export interface CmoSummaryMetric {
  readonly key: CmoSummaryKey;
  /** Short CMO-facing label. */
  readonly label: string;
  /** The value to show. For non-receipt provenance this is a short state phrase, NEVER a fabricated number. */
  readonly value: string;
  readonly provenance: CmoMetricProvenance;
  /** The named source this metric is (or would be) read from. Sanitized; safe to render. */
  readonly source: string;
  /** One short supporting line. Sanitized; safe to render. */
  readonly detail: string;
  /** A real receipt link when one exists (provenance "receipt"). */
  readonly receiptHref?: string;
  /** True when an owner action is required to unblock (provenance "blocked"). */
  readonly needsOwner: boolean;
}

/** An upgrade/connect prompt that only appears when real value sits behind a real limit (no arbitrary copy). */
export interface CmoUpgradeMoment {
  readonly reason: string;
  readonly cta: string;
  readonly proof: string;
}

export interface CmoSummary {
  /** True when computed from a live signed-in workspace (vs a sample/dogfood preview). */
  readonly live: boolean;
  readonly metrics: readonly CmoSummaryMetric[];
  readonly upgradeMoment?: CmoUpgradeMoment;
}

export interface CmoSummaryInput {
  readonly live: boolean;
  readonly connectors: readonly EverydayConnector[];
  readonly approvals: readonly ApprovalCard[];
  readonly receipts: readonly ExternalAction[];
}

/**
 * Strip control characters and cap length so untrusted connector text (#200 §6) is safe to render and can
 * never carry an instruction payload into the UI. Uses charCodeAt (eslint `no-control-regex` forbids a
 * control-char regex class). Pure.
 */
function sanitizeText(raw: string, max = 80): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    // drop C0/C1 control chars; keep everything printable.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
    if (out.length >= max) break;
  }
  return out.trim();
}

/** Connector groups that would SOURCE a given metric. Structural — the only thing provenance keys off of. */
const SOURCE_GROUPS: Record<"pipeline" | "leads", readonly EverydayConnector["group"][]> = {
  // pipeline created/touched comes from analytics/CRM visibility connectors.
  pipeline: ["visibility"],
  // qualified leads / conversations / meetings come from customer marketing connectors.
  leads: ["marketing"],
};

interface GroupSourceState {
  readonly provenance: CmoMetricProvenance;
  readonly source: string;
  readonly needsOwner: boolean;
}

/** Resolve whether the connectors in the given groups are connected / blocked / not-wired. Pure. */
function resolveGroupSource(
  connectors: readonly EverydayConnector[],
  groups: readonly EverydayConnector["group"][],
): GroupSourceState {
  const relevant = connectors.filter((c) => groups.includes(c.group));
  const connected = relevant.filter((c) => c.status === "connected");
  const blocked = relevant.filter((c) => c.status === "blocked");
  if (connected.length > 0) {
    return { provenance: "receipt", source: sanitizeText(connected.map((c) => c.name).join(", ")), needsOwner: false };
  }
  if (blocked.length > 0) {
    return { provenance: "blocked", source: sanitizeText(blocked.map((c) => c.name).join(", ")), needsOwner: true };
  }
  return { provenance: "not_connected", source: "", needsOwner: false };
}

function groupMetric(
  key: "pipeline" | "leads",
  label: string,
  thing: string,
  connectors: readonly EverydayConnector[],
): CmoSummaryMetric {
  const src = resolveGroupSource(connectors, SOURCE_GROUPS[key]);
  if (src.provenance === "receipt") {
    // Source is connected, but we deliberately pull no external data here (no credentials in scope), so we
    // report the honest connected-but-unsynced state instead of inventing a count.
    return {
      key,
      label,
      value: "connected",
      provenance: "receipt",
      source: src.source,
      detail: `${src.source} connected · first ${thing} sync pending`,
      needsOwner: false,
    };
  }
  if (src.provenance === "blocked") {
    return {
      key,
      label,
      value: "needs owner",
      provenance: "blocked",
      source: src.source,
      detail: `blocked — connect ${src.source} to track ${thing}`,
      needsOwner: true,
    };
  }
  return {
    key,
    label,
    value: "not connected",
    provenance: "not_connected",
    source: "",
    detail: `connect a source to track ${thing}`,
    needsOwner: false,
  };
}

function shippedMetric(
  connectors: readonly EverydayConnector[],
  receipts: readonly ExternalAction[],
): CmoSummaryMetric {
  const publishConnected = connectors.filter((c) => c.group === "publishing" && c.status === "connected");
  if (receipts.length > 0) {
    const last = receipts[receipts.length - 1];
    const channels = publishConnected.length > 0 ? sanitizeText(publishConnected.map((c) => c.name).join(", ")) : "this workspace";
    return {
      key: "shipped",
      label: "assets shipped",
      value: String(receipts.length),
      provenance: "receipt",
      source: "transparency receipt log",
      detail: `${receipts.length} shipped via ${channels}`,
      receiptHref: last?.href,
      needsOwner: false,
    };
  }
  if (publishConnected.length > 0) {
    // a publishing channel is live but nothing shipped yet — a real measured zero, honestly.
    return {
      key: "shipped",
      label: "assets shipped",
      value: "0",
      provenance: "receipt",
      source: "transparency receipt log",
      detail: `${sanitizeText(publishConnected.map((c) => c.name).join(", "))} live · nothing shipped yet`,
      needsOwner: false,
    };
  }
  return {
    key: "shipped",
    label: "assets shipped",
    value: "not connected",
    provenance: "not_connected",
    source: "",
    detail: "connect a publishing channel to ship assets",
    needsOwner: false,
  };
}

function revenueMetric(): CmoSummaryMetric {
  // Spend/revenue lives behind money movement, which is owner-gated and never automated (#200 §4 + the
  // task's hard boundary: "render it as blocked — needs owner rather than faking it").
  return {
    key: "revenue",
    label: "spend / revenue",
    value: "needs owner",
    provenance: "blocked",
    source: "billing connector",
    detail: "blocked — owner must connect billing to track spend/revenue",
    needsOwner: true,
  };
}

function approvalsMetric(approvals: readonly ApprovalCard[]): CmoSummaryMetric {
  const count = approvals.length;
  return {
    key: "approvals",
    label: "waiting on you",
    value: String(count),
    provenance: "receipt",
    source: "workspace approval queue",
    detail: count > 0 ? `${count} owner decision(s) needed now` : "nothing waiting on you",
    needsOwner: count > 0,
  };
}

function channelsMetric(connectors: readonly EverydayConnector[]): CmoSummaryMetric {
  const connected = connectors.filter((c) => c.status === "connected").length;
  const blocked = connectors.filter((c) => c.status === "blocked" || c.status === "coming_soon").length;
  const pending = connectors.filter((c) => c.status === "pending").length;
  const detailParts = [`${connected} live`];
  if (blocked > 0) detailParts.push(`${blocked} blocked`);
  if (pending > 0) detailParts.push(`${pending} verifying`);
  return {
    key: "channels",
    label: "channels live",
    value: String(connected),
    provenance: "receipt",
    source: "workspace connector catalog",
    detail: connectors.length === 0 ? "no channels connected yet" : detailParts.join(" · "),
    needsOwner: false,
  };
}

/**
 * Resolve the six-metric CMO summary. Pure + deterministic. Returns an upgrade/connect moment ONLY when real,
 * receipt-backed value (a shipped receipt or a pending approval) sits behind a genuinely blocked channel — so
 * the prompt is always tied to proven value, never arbitrary pricing copy.
 */
export function resolveCmoSummary(input: CmoSummaryInput): CmoSummary {
  const metrics: CmoSummaryMetric[] = [
    groupMetric("pipeline", "pipeline touched", "pipeline", input.connectors),
    groupMetric("leads", "qualified leads", "leads", input.connectors),
    shippedMetric(input.connectors, input.receipts),
    revenueMetric(),
    approvalsMetric(input.approvals),
    channelsMetric(input.connectors),
  ];

  const realValueCount = input.receipts.length + input.approvals.length;
  const blockedChannel = input.connectors.find((c) => c.status === "blocked");
  let upgradeMoment: CmoUpgradeMoment | undefined;
  if (realValueCount > 0 && blockedChannel) {
    const channelName = sanitizeText(blockedChannel.name);
    const proofBits: string[] = [];
    if (input.receipts.length > 0) proofBits.push(`${input.receipts.length} shipped receipt(s)`);
    if (input.approvals.length > 0) proofBits.push(`${input.approvals.length} approval(s) waiting`);
    upgradeMoment = {
      reason: `Real work is landing but ${channelName} is blocked — you're leaving its pipeline on the table.`,
      cta: `Connect ${channelName}`,
      proof: proofBits.join(" · "),
    };
  }

  return { live: input.live, metrics, upgradeMoment };
}
