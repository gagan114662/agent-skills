/**
 * Tamper-evident audit log of external actions (#672) — shared types.
 *
 * Issue #672 asks for an append-only, tamper-evident record of every action the platform takes
 * *outside its own boundary* — a publish, a send, a post, a spend, or an API call to a third party —
 * carrying who did it (actor), when (timestamp), what it touched (target), and a receipt/link back to
 * the side effect. This file holds the wire shapes; the tamper-evidence lives in {@link ./chain.ts}
 * (a hash chain) and the append-only IO in {@link ./store.ts}.
 *
 * This is deliberately distinct from the #147 `audit/` read-model, which *projects* three already-
 * recorded internal sources (approvals/runs/launches) into a viewing feed. That feed can drift from a
 * deleted row and proves nothing about integrity. This module is the opposite: it is the *source of
 * record* for outbound side effects, and each entry is cryptographically linked to the one before it,
 * so a silent edit or deletion anywhere in the history is detectable.
 */

/**
 * The kind of external action being recorded. These are the outbound categories named in #672; `kind`
 * stays a string union (not an enum) so a new outbound channel can record without a schema change, but
 * the named members document the intended taxonomy and give callers autocomplete.
 */
export type ExternalActionKind =
  | "publish" // content/site/page pushed live to the public web
  | "send" // an email / DM / message delivered to a recipient
  | "post" // a social or third-party-platform post
  | "spend" // money moved (a charge, payout, ad spend)
  | "api_call" // a write/side-effecting call to a third-party API
  | (string & {});

/** Who performed the action. `system` covers automation with no human/agent attribution. */
export type ActorType = "human" | "agent" | "system";

/** The actor that caused the external action. `id` is null for un-attributed system actions. */
export interface AuditActor {
  type: ActorType;
  /** Stable id (member id, agent id) when known; null for anonymous system actions. */
  id: string | null;
  /** Human-readable label for display (e.g. "Alice", "SEO Scout", "system"). */
  label: string;
}

/** A receipt/link proving the side effect happened (#672: "a receipt/link"). */
export interface AuditReceipt {
  /** Receipt classification, e.g. `url`, `message_id`, `charge_id`, `http_status`. */
  type: string;
  /** The receipt value — a URL, provider id, transaction id, etc. */
  value: string;
}

/**
 * What a caller hands to {@link ExternalActionAuditLog.record}. Everything the system knows at the
 * moment of the side effect; the log seals it (timestamp, sequence, hash) into an {@link AuditRecord}.
 */
export interface ExternalActionInput {
  /** Tenant boundary (#3/#19). Required so an export can be scoped to one workspace. */
  workspaceId: string;
  actor: AuditActor;
  kind: ExternalActionKind;
  /** What the action touched: a URL, recipient, channel, vendor, account. */
  target: string;
  /** One-line description of the action. */
  summary: string;
  /** Receipt/link for the side effect, when one exists (a publish URL, a message id, a charge id). */
  receipt?: AuditReceipt | null;
  /** Optional structured context (provider, amount, request id). Sealed into the hash. */
  metadata?: Record<string, unknown>;
}

/**
 * A sealed, append-only audit entry. `prevHash`/`hash` form the tamper-evident chain: `hash` covers
 * every other field of this record *plus* `prevHash`, so changing any field — or reordering/removing
 * an entry — breaks verification from that point on. Records are immutable once written.
 */
export interface AuditRecord {
  /** 1-based monotonic position in the chain. */
  seq: number;
  /** ISO-8601 UTC time the action was sealed. */
  at: string;
  workspaceId: string;
  actor: AuditActor;
  kind: ExternalActionKind;
  target: string;
  summary: string;
  receipt: AuditReceipt | null;
  metadata: Record<string, unknown>;
  /** Hash of the previous record (or the genesis constant for the first). */
  prevHash: string;
  /** Hash over this record's content + `prevHash`. The tamper-evidence anchor. */
  hash: string;
}

/** The outcome of verifying a chain's integrity. */
export interface VerifyResult {
  ok: boolean;
  /** Number of records checked. */
  length: number;
  /** First failure, if any. */
  brokenAt?: {
    seq: number;
    reason: "hash_mismatch" | "broken_link" | "bad_sequence";
  };
}
