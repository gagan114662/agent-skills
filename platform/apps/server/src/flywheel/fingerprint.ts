import { createHash } from "node:crypto";
import type { FailureClass, FailureEvent } from "./types.js";

/**
 * Failure fingerprinting (#117, ADR-0117 §2) — **pure + unit-tested**. Two incarnations of the same
 * bug differ only in volatile tokens (a session uuid, a hex address, a line number, a timestamp). We
 * strip those, then hash `class + normalized message` so the same *shape* of failure collides to one
 * stable signature — the dedup key behind `unique(workspace_id, signature)`. The class is part of the
 * hash so an identical message from two sources stays two fingerprints (different repro, different fix).
 *
 * No IO, no clock, no randomness: a given event always yields the same signature, which is what makes
 * "same failure twice = one row" a database invariant rather than a hope.
 */

/** Volatile-token scrubbers, applied in order. Each turns a noisy id into a stable placeholder. */
const NORMALIZERS: Array<[RegExp, string]> = [
  // UUIDs (session ids, request ids).
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  // ISO-8601 timestamps.
  [/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/gi, "<ts>"],
  // Hex blobs / addresses (0x… or bare ≥8-char hex runs).
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  // file:line:col suffixes (keep the path shape, drop the moving numbers).
  [/:\d+:\d+\b/g, ":<n>:<n>"],
  [/:\d+\b/g, ":<n>"],
  // Any remaining standalone number run.
  [/\b\d+\b/g, "<n>"],
];

/** Normalize a failure message into a stable, id-free shape. Collapses whitespace and lowercases. */
export function normalizeMessage(message: string): string {
  let out = message.toLowerCase();
  for (const [re, replacement] of NORMALIZERS) out = out.replace(re, replacement);
  return out.replace(/\s+/g, " ").trim();
}

/** A short, human-readable title for the synthesized issue — the class plus the first line, capped. */
function deriveTitle(failureClass: FailureClass, message: string): string {
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  const capped = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  return `[flywheel:${failureClass}] ${capped || "(no message)"}`;
}

export interface Fingerprint {
  /** The stable dedup key — 16 hex chars of `sha256(class + "\n" + normalized message)`. */
  signature: string;
  /** A display title for the synthesized issue. */
  title: string;
}

/** Compute the stable fingerprint of a failure event. Pure + deterministic. */
export function fingerprintFailure(event: Pick<FailureEvent, "failureClass" | "message">): Fingerprint {
  const normalized = normalizeMessage(event.message);
  const signature = createHash("sha256")
    .update(`${event.failureClass}\n${normalized}`)
    .digest("hex")
    .slice(0, 16);
  return { signature, title: deriveTitle(event.failureClass, event.message) };
}
