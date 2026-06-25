import { slugify } from "./memory.js";
import type { PlaybookProvenance, PlaybookRecord } from "./types.js";

/**
 * Cross-venture playbooks (#197, ADR-0197). **Pure** — no DB. A playbook is a reusable pattern distilled
 * from one venture's externally-verified (#106) win, anonymized so the pattern leaks no venture identity,
 * carrying provenance (a HASH of the source venture + the verifier receipt) so the owner can audit
 * lineage. "Cross-venture" stays inside the `workspace_id` tenant boundary (#3): across one owner's
 * ventures, never cross-tenant. An un-receipted "win" is not a pattern — distillation requires a #106 id.
 */

/**
 * A stable, dependency-free FNV-1a hash of a venture id → 8 hex chars. Used to anonymize provenance: the
 * owner can confirm two playbooks share a source venture (same hash) without the hash revealing which.
 * Deterministic ⇒ unit-testable and idempotent (the same venture always hashes the same).
 */
export function ventureHash(ideaId: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < ideaId.length; i++) {
    h ^= ideaId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, kept in uint32
  }
  return h.toString(16).padStart(8, "0");
}

/** A venture win offered for distillation into a playbook. */
export interface PlaybookWin {
  ideaId: string;
  category: string;
  segment?: string | null;
  targetUser?: string | null;
  /** The reusable lesson — MUST NOT contain venture-identifying text (the distiller enforces this). */
  pattern: string;
  outcome: string;
  evidence: string;
  /** The #106 verifier-result id that earned the win. Null ⇒ not a pattern (distillation refuses it). */
  verifierResultId: string | null;
}

/** A distilled playbook ready to persist (no id/timestamps — the repo mints those). */
export interface DistilledPlaybook {
  category: string;
  pattern: string;
  provenance: PlaybookProvenance[];
  dedupeKey: string;
}

/**
 * Distill a win into an anonymized, provenance-bearing playbook — or null when it has no #106 receipt
 * (an un-verified "win" is fiction, premortem #200 modes 2–3) or its pattern leaks the venture id. The
 * `dedupeKey` (`pb:<category>:<slug(pattern)>`) makes re-distilling the same lesson idempotent.
 */
export function distillPlaybook(win: PlaybookWin): DistilledPlaybook | null {
  if (!win.verifierResultId) return null; // no externally-verified receipt ⇒ not a pattern
  if (win.pattern.includes(win.ideaId)) return null; // refuse a pattern that leaks the venture id
  const provenance: PlaybookProvenance = {
    sourceVentureHash: ventureHash(win.ideaId),
    segment: normalizeAudience(win.segment),
    targetUser: normalizeAudience(win.targetUser),
    outcome: win.outcome,
    evidence: win.evidence,
    verifierResultId: win.verifierResultId,
  };
  return {
    category: win.category,
    pattern: win.pattern,
    provenance: [provenance],
    dedupeKey: `pb:${slugify(win.category, 24)}:${slugify(win.pattern)}`,
  };
}

/**
 * The playbooks a target venture should consider — same-category first, then general. A playbook whose
 * provenance is entirely the target venture itself is excluded (you don't teach a venture its own lesson
 * back). Bounded by `limit`. Pure ⇒ the plan drafter and the read API agree.
 */
export function matchPlaybooks(
  playbooks: PlaybookRecord[],
  target: {
    ideaId: string;
    category?: string | null;
    segment?: string | null;
    targetUser?: string | null;
  },
  limit = 5,
): PlaybookRecord[] {
  const targetHash = ventureHash(target.ideaId);
  const targetSegment = normalizeAudience(target.segment);
  const targetUser = normalizeAudience(target.targetUser);
  const notSelfOnly = playbooks.filter(
    (p) => !p.provenance.every((pr) => pr.sourceVentureHash === targetHash),
  );
  const ranked = [...notSelfOnly].sort((a, b) => {
    const aMatch = target.category && a.category === target.category ? 0 : 1;
    const bMatch = target.category && b.category === target.category ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    const aAudience = audienceRank(a, targetSegment, targetUser);
    const bAudience = audienceRank(b, targetSegment, targetUser);
    if (aAudience !== bAudience) return aAudience - bAudience;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  return ranked.slice(0, Math.max(0, limit));
}

function normalizeAudience(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function audienceRank(
  playbook: PlaybookRecord,
  targetSegment: string | null,
  targetUser: string | null,
): number {
  if (!targetSegment && !targetUser) return 0;
  const anyAudience = playbook.provenance.some((pr) => pr.segment || pr.targetUser);
  const sameAudience = playbook.provenance.some(
    (pr) =>
      (targetSegment !== null && normalizeAudience(pr.segment) === targetSegment) ||
      (targetUser !== null && normalizeAudience(pr.targetUser) === targetUser),
  );
  if (sameAudience) return 0;
  return anyAudience ? 1 : 2;
}
