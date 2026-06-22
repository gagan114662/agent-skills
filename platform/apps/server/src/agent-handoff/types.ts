/**
 * A2A typed handoff contracts (#584) — the wire shapes.
 *
 * Problem (#584): agents hand work to each other through free-text messages. That loses structure,
 * duplicates work, and produced the runaway "handoff-chain" debris (junk blog files named after agent
 * chatter) seen in earlier PRs. The fix is to make a handoff a *typed, validated, persisted record* —
 * `{fromAgent, toAgent, artifactRef, intent, acceptanceCriteria, status}` — and to let an agent **accept**
 * a handoff only when it validates against this schema. Free text is metadata only (a human-readable
 * `note`); it is NEVER the payload an agent acts on.
 *
 * This is deliberately distinct from the two existing A2A pieces in `agent-registry/`:
 *   - `a2a.ts` (#282) governs whether agent A may *launch/call* agent B for a capability — a routing gate.
 *   - `handoff.ts` (#417) is the free-text `@mention` bridge — exactly the unstructured chatter #584 removes.
 * This module is the structured *contract* that rides over a handoff: the durable, validated record of
 * "what is being handed, to whom, why, and the criteria for accepting it." It is a self-contained library
 * (no migration, no schema barrel, no app-registry wiring) so it cannot collide with parallel work.
 *
 * Premortem (#200 §6): the only free-text fields — `acceptanceCriteria` items and `note` — are untrusted
 * DATA. They are sanitized (control chars stripped, whitespace collapsed, length-capped) on the way in,
 * they never name a tool, never widen scope, and never become instructions. The structural fields
 * (`fromAgent`, `toAgent`, `intent`, `artifactRef`) are validated against fixed charsets — they are the
 * payload, and they can only ever reference, never command.
 */

/**
 * The lifecycle of a handoff. A handoff is born `proposed`; the receiver either `accepted` it (only when
 * it validates) or `rejected` it; an accepted handoff ends `completed`; the proposer may `cancelled` a
 * still-open one. Terminal states (`rejected`, `completed`, `cancelled`) never transition again.
 */
export const HANDOFF_STATUSES = ["proposed", "accepted", "rejected", "completed", "cancelled"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** Terminal statuses — no further transition is permitted out of these. */
export const TERMINAL_STATUSES: readonly HandoffStatus[] = ["rejected", "completed", "cancelled"];

/**
 * A structured pointer to the artifact being handed off — the payload. This is intentionally a *reference*,
 * never the artifact's free-text content: `type` classifies it (e.g. `pr`, `blog_post`, `design`), `id` is
 * the stable identifier, and `uri` is an optional locator. An agent acts on the referenced artifact, not on
 * prose describing it.
 */
export interface ArtifactRef {
  /** Artifact class as a structural token, e.g. `pr`, `blog_post`, `design`, `dataset`. */
  type: string;
  /** Stable identifier within that class (a PR number, a slug, a row id). */
  id: string;
  /** Optional locator (a URL or path). Null/absent when the `type`+`id` are enough to resolve it. */
  uri?: string | null;
}

/**
 * What a caller hands to {@link HandoffService.propose}. `note` is the ONLY free-text field that survives,
 * and it is metadata for humans — never the thing an agent acts on. Validation rejects the proposal whole
 * if any structural field is malformed, so a half-formed handoff is never persisted.
 */
export interface HandoffProposal {
  /** Tenant boundary (#3/#19) so the handoff log can be scoped to one workspace. */
  workspaceId: string;
  /** The agent handing work off (a fleet handle). */
  fromAgent: string;
  /** The agent the work is handed to (a fleet handle). Must differ from `fromAgent`. */
  toAgent: string;
  /** Structured pointer to the artifact being handed off. */
  artifactRef: ArtifactRef;
  /** Why the handoff exists, as a structural verb token (e.g. `review`, `implement`, `publish`). */
  intent: string;
  /** The criteria the receiver must satisfy to consider the handoff done. Non-empty; each item is DATA. */
  acceptanceCriteria: string[];
  /** Optional free-text metadata for humans. Sanitized; never the payload. */
  note?: string | null;
}

/** One entry in a handoff's transition history — who moved it, to what, when, and (optionally) why. */
export interface HandoffEvent {
  /** ISO-8601 UTC time the transition was recorded. */
  at: string;
  /** The status entered. */
  status: HandoffStatus;
  /** The agent (or `system`) that caused the transition. */
  actor: string;
  /** Optional sanitized reason (e.g. a rejection note). DATA only. */
  reason: string | null;
}

/**
 * A persisted, validated handoff contract — the record visible in the handoff log. Every cross-agent
 * handoff is one of these; there is no other way to express a handoff in this module. The fields after
 * the proposal (`id`, timestamps, `status`, `history`) are stamped by the service.
 */
export interface HandoffContract {
  /** Stable id of the handoff. */
  id: string;
  workspaceId: string;
  fromAgent: string;
  toAgent: string;
  artifactRef: ArtifactRef;
  intent: string;
  acceptanceCriteria: string[];
  status: HandoffStatus;
  /** Free-text metadata (sanitized) or null. Never the payload. */
  note: string | null;
  /** ISO-8601 UTC creation time. */
  createdAt: string;
  /** ISO-8601 UTC time of the last transition. */
  updatedAt: string;
  /** Append-only transition history, oldest first (always starts with the `proposed` event). */
  history: HandoffEvent[];
}

/** The result of validating untrusted input against a schema: a normalized value, or a list of reasons. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/** The normalized, sanitized form of a {@link HandoffProposal} that validation produces. */
export interface NormalizedProposal {
  workspaceId: string;
  fromAgent: string;
  toAgent: string;
  artifactRef: ArtifactRef;
  intent: string;
  acceptanceCriteria: string[];
  note: string | null;
}
