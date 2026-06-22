/**
 * The tamper-evidence for the #672 external-action log: a SHA-256 hash chain.
 *
 * Each sealed record carries `hash = sha256(prevHash + "\n" + canonical(content))`, where `content` is
 * every field of the record except `hash`, serialized with deterministically ordered keys. Because the
 * hash folds in the previous record's hash, the entries form a chain: tamper with any field of record
 * N (or drop/reorder a record) and N's recomputed hash no longer matches what is stored, *and* every
 * later record's `prevHash` linkage breaks too. Verification recomputes the whole chain and reports the
 * first divergence.
 *
 * Pure and dependency-light (only `node:crypto`, mirroring `crypto/secretbox.ts`). No IO — the store
 * supplies the previous hash and persists the result.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { AuditRecord, ExternalActionInput, VerifyResult } from "./types.js";

/** The chain's anchor: the `prevHash` of the very first record. */
export const GENESIS_HASH = "GENESIS";

/** The hashed content of a record — everything except the `hash` itself. */
export type SealedContent = Omit<AuditRecord, "hash">;

/** Project a record onto its hashed content (everything but `hash`), for re-hashing/verification. */
export function contentOf(record: AuditRecord): SealedContent {
  return {
    seq: record.seq,
    at: record.at,
    workspaceId: record.workspaceId,
    actor: record.actor,
    kind: record.kind,
    target: record.target,
    summary: record.summary,
    receipt: record.receipt,
    metadata: record.metadata,
    prevHash: record.prevHash,
  };
}

/**
 * Deterministic serialization: object keys are emitted in sorted order, recursively, so two records
 * with the same logical content always hash identically regardless of key insertion order. Arrays keep
 * their order (it is meaningful). This is what makes the hash reproducible across processes.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/** Compute the hash that anchors a record to its predecessor. */
export function computeHash(content: SealedContent): string {
  return createHash("sha256").update(`${content.prevHash}\n${canonicalize(content)}`).digest("hex");
}

/** Constant-time hash comparison (avoids leaking where a forged chain first diverges). */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Seal a caller's input into an immutable, hash-linked record. `prev` is the current chain head (or
 * null for the first record). Normalizes optional fields so the hashed content is always fully defined.
 */
export function sealRecord(prev: AuditRecord | null, input: ExternalActionInput, at: string): AuditRecord {
  const content: SealedContent = {
    seq: prev ? prev.seq + 1 : 1,
    at,
    workspaceId: input.workspaceId,
    actor: input.actor,
    kind: input.kind,
    target: input.target,
    summary: input.summary,
    receipt: input.receipt ?? null,
    metadata: input.metadata ?? {},
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return { ...content, hash: computeHash(content) };
}

/**
 * Recompute the whole chain and report the first integrity failure. Checks three invariants per
 * record: the sequence is contiguous from 1, the `prevHash` links to the prior record's hash, and the
 * stored `hash` matches a fresh recomputation of the content. `ok` is true only for a fully intact log.
 */
export function verifyChain(records: readonly AuditRecord[]): VerifyResult {
  let prevHash = GENESIS_HASH;
  let i = 0;
  for (const r of records) {
    i += 1;
    if (r.seq !== i) {
      return { ok: false, length: records.length, brokenAt: { seq: r.seq, reason: "bad_sequence" } };
    }
    if (r.prevHash !== prevHash) {
      return { ok: false, length: records.length, brokenAt: { seq: r.seq, reason: "broken_link" } };
    }
    if (!hashesEqual(computeHash(contentOf(r)), r.hash)) {
      return { ok: false, length: records.length, brokenAt: { seq: r.seq, reason: "hash_mismatch" } };
    }
    prevHash = r.hash;
  }
  return { ok: true, length: records.length };
}
