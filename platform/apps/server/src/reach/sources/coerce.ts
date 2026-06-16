import { isReachSignalKind, type BuyingSignal, type ProspectSourceKind, type RawProspect } from "../types.js";

/**
 * Defensive JSON → prospect coercion shared by the paid HTTP adapters (#280). Provider responses are
 * untrusted input: every field is read defensively (wrong type ⇒ null/empty, never a throw) so a malformed
 * or hostile payload can degrade a batch but never crash the loop or smuggle a non-string into a send field.
 */

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Read the array of result rows out of a few common envelope shapes (`data`, `people`, `results`, `[]`). */
export function resultRows(json: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.map(asRecord);
  const obj = asRecord(json);
  for (const k of keys) {
    if (Array.isArray(obj[k])) return asArray(obj[k]).map(asRecord);
  }
  return [];
}

const MAX_SIGNALS = 5;

/**
 * Coerce a provider signal list into typed {@link BuyingSignal}s. Only KNOWN signal kinds survive (closed
 * enum) — an unknown/poisoned `kind` string is dropped, never routed on. The summary stays raw here; it is
 * sanitised at personalisation time (the single quarantine choke point).
 */
export function coerceSignals(raw: unknown, nowMs: number): BuyingSignal[] {
  const out: BuyingSignal[] = [];
  for (const item of asArray(raw)) {
    const rec = asRecord(item);
    const kind = asString(rec.kind ?? rec.type ?? rec.signal);
    if (!kind || !isReachSignalKind(kind)) continue;
    const summary = asString(rec.summary ?? rec.description ?? rec.detail) ?? "";
    const observedAt = rec.observedAt ?? rec.date ?? rec.timestamp;
    const observedAtMs =
      typeof observedAt === "number"
        ? observedAt
        : typeof observedAt === "string" && !Number.isNaN(Date.parse(observedAt))
          ? Date.parse(observedAt)
          : nowMs;
    out.push({ kind, summary, observedAtMs });
    if (out.length >= MAX_SIGNALS) break;
  }
  return out;
}

/** Coerce one provider contact row into a structured {@link RawProspect}. Returns null when unusable. */
export function coerceProspect(
  rec: Record<string, unknown>,
  sourceKind: ProspectSourceKind,
  nowMs: number,
): RawProspect | null {
  const fullName =
    asString(rec.fullName ?? rec.name) ??
    [asString(rec.firstName), asString(rec.lastName)].filter(Boolean).join(" ").trim();
  const company = asString(rec.company ?? rec.companyName ?? rec.organization);
  const email = asString(rec.email ?? rec.workEmail);
  const linkedinUrl = asString(rec.linkedinUrl ?? rec.linkedin ?? rec.linkedInUrl);
  // Need a name + company, and at least one way to reach them.
  if (!fullName || !company || (!email && !linkedinUrl)) return null;
  return {
    fullName,
    title: asString(rec.title ?? rec.jobTitle ?? rec.role) ?? "",
    company,
    companyDomain: asString(rec.companyDomain ?? rec.domain ?? rec.website) ?? "",
    email,
    linkedinUrl,
    industry: asString(rec.industry),
    companySize: asString(rec.companySize ?? rec.employeeRange ?? rec.size),
    signals: coerceSignals(rec.signals ?? rec.intent ?? rec.buyingSignals, nowMs),
    sourceKind,
  };
}
