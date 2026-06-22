/**
 * The portable, restorable export envelope for a workspace backup (issue #676).
 *
 * A workspace's data is captured as a {@link WorkspaceSnapshot} — a map of named collections (opaque,
 * JSON-serializable rows) — and wrapped in an {@link ExportEnvelope} that carries a format tag, a schema
 * version, the owning workspace id, a creation timestamp, and a SHA-256 **checksum** over the snapshot.
 * The checksum is what makes an export *restorable with confidence*: restore recomputes it and refuses any
 * envelope whose bytes were truncated, edited, or corrupted in transit. This mirrors the tamper-evidence
 * approach of the #672 audit chain (`external-audit/chain.ts`) — deterministic canonical serialization +
 * `node:crypto`, no IO.
 *
 * Everything here is pure (given its arguments): the same snapshot always produces the same checksum across
 * processes, so a round-trip (build → serialize → deserialize → verify) is fully unit-testable with no DB.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Magic string identifying the envelope format; restore rejects anything else. */
export const EXPORT_FORMAT = "workspace-backup" as const;

/** Current envelope schema version. Restore refuses versions it does not understand (fail-closed). */
export const EXPORT_FORMAT_VERSION = 1 as const;

/**
 * A workspace's exportable data: a map of collection name → rows. Rows are opaque JSON values; this module
 * never interprets them, so the snapshot shape is decoupled from any particular table or repository. The
 * data source decides which collections to include; restore replays them verbatim.
 */
export interface WorkspaceSnapshot {
  collections: Record<string, unknown[]>;
}

/** The self-describing, integrity-checked unit a user downloads and can later restore from. */
export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT;
  version: number;
  workspaceId: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** SHA-256 (hex) over the canonical serialization of {@link snapshot}. */
  checksum: string;
  snapshot: WorkspaceSnapshot;
}

/**
 * Deterministic serialization: object keys emitted in sorted order, recursively, so two snapshots with the
 * same logical content hash identically regardless of key insertion order. Array order is preserved (it is
 * meaningful). Copied in spirit from `external-audit/chain.ts` so the checksum is reproducible everywhere.
 */
export function canonicalize(value: unknown): string {
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

/** The checksum of a snapshot: SHA-256 (hex) over its canonical form. */
export function checksumSnapshot(snapshot: WorkspaceSnapshot): string {
  return createHash("sha256").update(canonicalize(snapshot)).digest("hex");
}

/** Total row count across every collection in a snapshot. */
export function countRows(snapshot: WorkspaceSnapshot): number {
  return Object.values(snapshot.collections).reduce((sum, rows) => sum + rows.length, 0);
}

/** Per-collection row counts (used for backup metadata / UI summaries). */
export function collectionCounts(snapshot: WorkspaceSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(snapshot.collections)) counts[name] = rows.length;
  return counts;
}

/** Build a checksummed export envelope for a workspace's snapshot. Pure given its arguments. */
export function buildEnvelope(workspaceId: string, snapshot: WorkspaceSnapshot, now: Date): ExportEnvelope {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    workspaceId,
    createdAt: now.toISOString(),
    checksum: checksumSnapshot(snapshot),
    snapshot,
  };
}

/** Serialize an envelope to the bytes a user downloads. */
export function serializeEnvelope(envelope: ExportEnvelope): string {
  return JSON.stringify(envelope);
}

/** Outcome of validating an envelope before restore. */
export type VerifyResult = { ok: true } | { ok: false; reason: string };

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (value === null || typeof value !== "object") return false;
  const collections = (value as { collections?: unknown }).collections;
  if (collections === null || typeof collections !== "object" || Array.isArray(collections)) return false;
  return Object.values(collections as Record<string, unknown>).every((rows) => Array.isArray(rows));
}

/**
 * Validate an arbitrary value as a usable {@link ExportEnvelope}: structural shape, recognized format +
 * version, and a checksum that matches the snapshot. **Fail-closed** — any deviation returns a reason and
 * restore must refuse. Constant-time checksum comparison (mirrors the audit chain) avoids leaking a match
 * position to a tamperer.
 */
export function verifyEnvelope(value: unknown): VerifyResult {
  if (value === null || typeof value !== "object") return { ok: false, reason: "not an object" };
  const env = value as Partial<ExportEnvelope>;
  if (env.format !== EXPORT_FORMAT) return { ok: false, reason: "unrecognized format" };
  if (env.version !== EXPORT_FORMAT_VERSION) return { ok: false, reason: `unsupported version ${String(env.version)}` };
  if (typeof env.workspaceId !== "string" || env.workspaceId.length === 0)
    return { ok: false, reason: "missing workspaceId" };
  if (typeof env.checksum !== "string" || env.checksum.length === 0)
    return { ok: false, reason: "missing checksum" };
  if (!isSnapshot(env.snapshot)) return { ok: false, reason: "malformed snapshot" };
  const expected = checksumSnapshot(env.snapshot);
  const a = Buffer.from(env.checksum, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "checksum mismatch" };
  return { ok: true };
}

/** Parse serialized envelope bytes into a verified {@link ExportEnvelope}, or return a reason on failure. */
export function parseEnvelope(text: string): { ok: true; envelope: ExportEnvelope } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  const verdict = verifyEnvelope(value);
  if (!verdict.ok) return verdict;
  return { ok: true, envelope: value as ExportEnvelope };
}
