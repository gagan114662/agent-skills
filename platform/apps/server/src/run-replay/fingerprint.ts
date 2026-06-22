/**
 * Deterministic fingerprinting for run-replay (issue #668). A capture is only useful if it is
 * *reproducible*: the same logical inputs must always hash to the same value, in any process, regardless of
 * object key order. This module provides the canonical serialization + SHA-256 used to fingerprint both a
 * run's inputs (the integrity + dedup key) and its output (to confirm a successful replay is identical).
 *
 * Copied in spirit from `backup/archive.ts` (#676) and the #672 audit chain: pure, no IO, no `Date`.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic serialization: object keys emitted in sorted order, recursively, so two values with the
 * same logical content serialize identically regardless of key insertion order. Array order is preserved
 * (it is meaningful). `undefined` is normalized to `null` so it round-trips through JSON consistently.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${entries.join(",")}}`;
}

/** SHA-256 (hex) over the canonical serialization of any JSON-serializable value. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
