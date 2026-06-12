import { createHash } from "node:crypto";
import type { QaSurface } from "./types.js";

/**
 * Deterministic dedup fingerprinting (#171, ADR-0171) — **pure + unit-tested**. A failed check has one
 * identity: the broken check itself. So the signature hashes `surface + checkId` and nothing volatile —
 * the same broken check yields the same 16-hex signature every run, which is what makes "same bug twice
 * = one issue" a property (the GitHub body-marker dedup key, and a stable flywheel signature) rather than
 * a hope. The volatile failure detail (a run id, a timestamp, a screenshot path) is deliberately NOT in
 * the hash, so a flaky message never forks one bug into two issues.
 */
export function fingerprintFinding(input: { surface: QaSurface; checkId: string; actual?: string }): string {
  return createHash("sha256").update(`${input.surface}::${input.checkId}`).digest("hex").slice(0, 16);
}

/** Volatile-token scrubbers for the human-readable failure detail (NOT the signature — see above). */
const NORMALIZERS: Array<[RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/gi, "<ts>"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\/[^\s)]+/g, "<path>"], // file/url paths — drop before the number scrubber so digits inside are gone
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  [/\b\d+\b/g, "<n>"],
];

/**
 * Normalize a free-form failure detail into a stable, id-free shape for the issue body / flywheel
 * message. Collapses whitespace and lowercases. Pure + deterministic.
 */
export function normalizeActual(actual: string): string {
  let out = actual.toLowerCase();
  for (const [re, replacement] of NORMALIZERS) out = out.replace(re, replacement);
  return out.replace(/\s+/g, " ").trim();
}
