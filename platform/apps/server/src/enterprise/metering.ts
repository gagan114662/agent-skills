/**
 * Enterprise per-agent + per-customer usage metering (issue #340, ADR-0340). PURE shaping + the
 * verification predicate + the read-side aggregations. The enterprise layer is how ipop can sell the fleet:
 * it records WHO (which department agent) used WHAT (a model / tool / action) for WHICH customer (workspace),
 * how many units, the cost of goods, and — when the provider returned one — an EXTERNAL receipt reference.
 *
 * Premortem (#200) encoded in the SHAPE, not by convention:
 *  - **§2 self-reported metrics are fiction.** A usage row is `verified` (and `provenance: "external"`) ONLY
 *    when it carries a non-empty `externalRef` — a provider receipt / request id proving the call happened.
 *    `verified` is DERIVED here, never a caller field, so an agent can never self-assert a billable number;
 *    the billing/read surface sums only verified rows ({@link verifiedCostCents}).
 *  - **§6 injection defense.** Provider/agent-supplied free text (`resource`, `provider`) is UNTRUSTED — it is
 *    sanitized ({@link sanitizeProviderText}: control chars stripped, length capped) before it is shaped, and
 *    numbers are clamped to a non-negative finite integer so a poisoned cost can never go negative to evade a
 *    cap nor non-finite to corrupt a sum. No decision is ever taken from this free text — only recorded.
 *
 * The IO seam (persist / list) lives in `service.ts` + the repo; runtime flags in `caps.ts`. This module has
 * no IO and no clock of its own (`nowMs` is injected) so the whole metering model is unit-tested in isolation.
 */

/** What a usage row meters: a model call, a tool invocation, or a governed action. */
export type UsageKind = "model" | "tool" | "action";

/** Where a usage number came from. `external` = a provider receipt grounds it (verified); `internal_estimate`
 * = no receipt (UNVERIFIED — never drives a hard billing/cap number on its own). */
export type UsageProvenance = "external" | "internal_estimate";

/** A usage measurement an adapter hands the meter. `costCents` is the cost of goods the call incurred. */
export interface UsageMeasurement {
  /** The customer (tenant) the usage belongs to. */
  workspaceId: string;
  /** The department agent / persona that used the resource (the per-agent dimension). */
  agentId: string;
  kind: UsageKind;
  /** Model id / tool name / action type. UNTRUSTED free text — sanitized before persistence. */
  resource: string;
  /** Billable units the call consumed (API calls / tokens / rows). Non-negative; clamped. */
  units: number;
  /** Cost of goods in cents the call incurred (>= 0; clamped). */
  costCents: number;
  /** The provider's receipt / request id proving the call happened. Empty/undefined ⇒ UNVERIFIED. */
  externalRef?: string | null;
  /** Which provider emitted the receipt (e.g. `anthropic`, `stripe`). UNTRUSTED free text — sanitized. */
  provider?: string | null;
}

/** A shaped usage row ready to persist. `verified`/`provenance` are DERIVED from `externalRef`, never asserted. */
export interface UsageReceipt {
  /** A deterministic provenance handle (a content hash) — the same measurement always hashes the same. */
  receiptId: string;
  workspaceId: string;
  agentId: string;
  kind: UsageKind;
  resource: string;
  provider: string | null;
  units: number;
  costCents: number;
  externalRef: string | null;
  provenance: UsageProvenance;
  /** True iff an external provider receipt grounds this row (premortem §2). */
  verified: boolean;
  occurredAtMs: number;
}

/** Per-agent or per-customer usage roll-up. Verified totals are tracked separately (premortem §2). */
export interface UsageRollup {
  totalCostCents: number;
  verifiedCostCents: number;
  units: number;
  verifiedUnits: number;
  eventCount: number;
}

/** A per-agent roll-up (carries the agent id alongside the {@link UsageRollup}). */
export interface AgentUsage extends UsageRollup {
  agentId: string;
}

/** A per-customer (workspace) roll-up. */
export interface CustomerUsage extends UsageRollup {
  workspaceId: string;
}

/** Max length any single provider-supplied free-text field is kept to once sanitized. */
const PROVIDER_TEXT_MAX = 200;

/**
 * Sanitize untrusted provider/agent free text (premortem §6): drop ASCII control characters (charCodeAt < 0x20
 * and DEL 0x7f), collapse runs of whitespace, trim, and cap the length. Uses a char-code scan (NOT a control
 * regex — eslint `no-control-regex`). Pure + total; a non-string becomes `""`.
 */
export function sanitizeProviderText(value: unknown, maxLen: number = PROVIDER_TEXT_MAX): string {
  if (typeof value !== "string") return "";
  let out = "";
  let lastWasSpace = false;
  for (let i = 0; i < value.length && out.length < maxLen; i++) {
    const code = value.charCodeAt(i);
    // Drop control chars (C0 < 0x20 and DEL 0x7f). Treat any whitespace as a single collapsed space.
    if (code < 0x20 || code === 0x7f) {
      if (!lastWasSpace && out.length > 0) {
        out += " ";
        lastWasSpace = true;
      }
      continue;
    }
    if (code === 0x20) {
      if (!lastWasSpace && out.length > 0) {
        out += " ";
        lastWasSpace = true;
      }
      continue;
    }
    out += value[i];
    lastWasSpace = false;
  }
  return out.slice(0, maxLen).trim();
}

/** True iff `ref` is a non-empty external receipt reference (the §2 grounding test). Pure + total. */
export function isExternalReceipt(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.trim().length > 0;
}

/** Clamp an arbitrary (possibly poisoned) number to a non-negative finite integer. */
function clampCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** A small, dependency-free FNV-1a hash (hex) so a receipt id is a deterministic content handle. */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in the unsigned 32-bit range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Shape a measurement into a persistable {@link UsageReceipt}. Derives `verified`/`provenance` from the
 * external receipt (never the caller), sanitizes the untrusted free text, clamps the numbers, and computes a
 * deterministic `receiptId` over the grounding fields. Pure — `nowMs` is injected.
 */
export function buildUsageReceipt(m: UsageMeasurement, nowMs: number): UsageReceipt {
  const externalRef = isExternalReceipt(m.externalRef) ? (m.externalRef as string).trim() : null;
  const verified = externalRef !== null;
  const resource = sanitizeProviderText(m.resource);
  const provider = isExternalReceipt(m.provider) ? sanitizeProviderText(m.provider) : null;
  // The provenance handle hashes the structural identity of the event: who/what/customer plus the external
  // receipt when present (so two rows with distinct receipts never collide), else the occurrence instant.
  const receiptId = fnv1aHex(
    [m.workspaceId, m.agentId, m.kind, resource, externalRef ?? `est:${nowMs}`].join(""),
  );
  return {
    receiptId,
    workspaceId: m.workspaceId,
    agentId: m.agentId,
    kind: m.kind,
    resource,
    provider,
    units: clampCount(m.units),
    costCents: clampCount(m.costCents),
    externalRef,
    provenance: verified ? "external" : "internal_estimate",
    verified,
    occurredAtMs: nowMs,
  };
}

/** Sum the cost of goods (cents) across only the VERIFIED rows — the billable total (premortem §2). */
export function verifiedCostCents(records: readonly UsageReceipt[]): number {
  return records.reduce((sum, r) => (r.verified ? sum + r.costCents : sum), 0);
}

/** Fold a set of receipts into one roll-up (total vs verified, units, count). */
function rollup(records: readonly UsageReceipt[]): UsageRollup {
  const acc: UsageRollup = {
    totalCostCents: 0,
    verifiedCostCents: 0,
    units: 0,
    verifiedUnits: 0,
    eventCount: 0,
  };
  for (const r of records) {
    acc.totalCostCents += r.costCents;
    acc.units += r.units;
    acc.eventCount += 1;
    if (r.verified) {
      acc.verifiedCostCents += r.costCents;
      acc.verifiedUnits += r.units;
    }
  }
  return acc;
}

/** Roll usage up per agent (the per-agent surface). Stable order: first-seen agent first. */
export function aggregateByAgent(records: readonly UsageReceipt[]): AgentUsage[] {
  const byAgent = new Map<string, UsageReceipt[]>();
  for (const r of records) {
    const list = byAgent.get(r.agentId);
    if (list) list.push(r);
    else byAgent.set(r.agentId, [r]);
  }
  return [...byAgent.entries()].map(([agentId, rows]) => ({ agentId, ...rollup(rows) }));
}

/** Roll a single customer's (workspace's) usage up (the per-customer surface). Filters to that workspace. */
export function aggregateByCustomer(records: readonly UsageReceipt[], workspaceId: string): CustomerUsage {
  const rows = records.filter((r) => r.workspaceId === workspaceId);
  return { workspaceId, ...rollup(rows) };
}
