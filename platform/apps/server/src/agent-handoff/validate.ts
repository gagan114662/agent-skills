/**
 * Schema validation for #584 typed handoff contracts — **pure**, total, dependency-free.
 *
 * This is the gate the whole feature turns on: a handoff is only ever created from a proposal that
 * validates here, and an agent can only **accept** a handoff that validates here. Validation takes
 * `unknown` (it sits at a trust boundary) and either returns a normalized, sanitized value or a list of
 * human-readable reasons — it never throws and never partially applies. Free-text fields are sanitized as
 * DATA; structural fields are checked against fixed charsets so a poisoned field can never name a tool or
 * widen scope (#200 §6).
 */

import {
  HANDOFF_STATUSES,
  type ArtifactRef,
  type HandoffContract,
  type HandoffStatus,
  type NormalizedProposal,
  type ValidationResult,
} from "./types.js";

/** Fleet handle charset — mirrors `agent-registry/a2a.ts HANDLE_RE` (handles are structural, never prose). */
const HANDLE_RE = /^[A-Za-z0-9._-]+$/;
/** Intent / artifact-type charset: a lowercase, dotted/segmented verb-or-noun token — never free text. */
const TOKEN_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
/** Artifact id charset: identifiers, slugs, paths, numbers — structural, no whitespace. */
const ARTIFACT_ID_RE = /^[A-Za-z0-9._:/#-]+$/;

const MAX_HANDLE_LENGTH = 64;
const MAX_INTENT_LENGTH = 64;
const MAX_ARTIFACT_ID_LENGTH = 256;
const MAX_URI_LENGTH = 2048;
const MAX_CRITERION_LENGTH = 500;
const MAX_CRITERIA = 20;
const MAX_NOTE_LENGTH = 1000;

/**
 * Sanitize untrusted free text into safe DATA: strip C0/C1 control characters (incl. NUL), collapse
 * whitespace runs, trim, and cap the length. Same defense-in-depth as `a2a.sanitizeTask` — the real
 * protection is architectural (this text never reaches a tool/scope); this just keeps the data clean.
 */
export function sanitizeText(text: string, maxLength: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxLength ? out.slice(0, maxLength).trim() : out;
}

/** Narrow an unknown to a plain object (not array, not null) without using `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Strip a single leading `@` so both `@mark` and `mark` normalize to the bare handle. */
function normalizeHandle(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function validateArtifactRef(value: unknown, errors: string[]): ArtifactRef | null {
  const rec = asRecord(value);
  if (!rec) {
    errors.push("artifactRef must be an object with { type, id }");
    return null;
  }
  let ok = true;
  const type = typeof rec.type === "string" ? rec.type.trim() : "";
  if (!TOKEN_RE.test(type)) {
    errors.push("artifactRef.type must be a lowercase token (e.g. pr, blog_post, design)");
    ok = false;
  }
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id || id.length > MAX_ARTIFACT_ID_LENGTH || !ARTIFACT_ID_RE.test(id)) {
    errors.push("artifactRef.id must be a non-empty identifier with no whitespace");
    ok = false;
  }
  let uri: string | null = null;
  if (rec.uri !== undefined && rec.uri !== null) {
    if (typeof rec.uri !== "string") {
      errors.push("artifactRef.uri must be a string when present");
      ok = false;
    } else {
      uri = sanitizeText(rec.uri, MAX_URI_LENGTH);
      if (!uri) {
        errors.push("artifactRef.uri must be non-empty when present");
        ok = false;
      }
    }
  }
  return ok ? { type, id, uri } : null;
}

function validateCriteria(value: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(value)) {
    errors.push("acceptanceCriteria must be a non-empty array of strings");
    return null;
  }
  if (value.length === 0) {
    errors.push("acceptanceCriteria must contain at least one criterion");
    return null;
  }
  if (value.length > MAX_CRITERIA) {
    errors.push(`acceptanceCriteria may contain at most ${MAX_CRITERIA} items`);
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push("every acceptance criterion must be a string");
      return null;
    }
    const clean = sanitizeText(item, MAX_CRITERION_LENGTH);
    if (!clean) {
      errors.push("acceptance criteria may not be empty after sanitization");
      return null;
    }
    out.push(clean);
  }
  return out;
}

/**
 * Validate untrusted proposal input into a {@link NormalizedProposal}. Collects every problem so a caller
 * sees all of them at once. Total — never throws.
 */
export function validateProposal(input: unknown): ValidationResult<NormalizedProposal> {
  const errors: string[] = [];
  const rec = asRecord(input);
  if (!rec) {
    return { ok: false, errors: ["handoff proposal must be an object"] };
  }

  const workspaceId = typeof rec.workspaceId === "string" ? rec.workspaceId.trim() : "";
  if (!workspaceId) {
    errors.push("workspaceId is required");
  }

  const fromAgent = typeof rec.fromAgent === "string" ? normalizeHandle(rec.fromAgent.trim()) : "";
  if (!HANDLE_RE.test(fromAgent) || fromAgent.length > MAX_HANDLE_LENGTH) {
    errors.push("fromAgent must be a valid agent handle");
  }

  const toAgent = typeof rec.toAgent === "string" ? normalizeHandle(rec.toAgent.trim()) : "";
  if (!HANDLE_RE.test(toAgent) || toAgent.length > MAX_HANDLE_LENGTH) {
    errors.push("toAgent must be a valid agent handle");
  }

  if (fromAgent && toAgent && fromAgent === toAgent) {
    errors.push("fromAgent and toAgent must differ (an agent cannot hand off to itself)");
  }

  const intent = typeof rec.intent === "string" ? rec.intent.trim() : "";
  if (!TOKEN_RE.test(intent) || intent.length > MAX_INTENT_LENGTH) {
    errors.push("intent must be a lowercase verb token (e.g. review, implement, publish)");
  }

  const artifactRef = validateArtifactRef(rec.artifactRef, errors);
  const acceptanceCriteria = validateCriteria(rec.acceptanceCriteria, errors);

  let note: string | null = null;
  if (rec.note !== undefined && rec.note !== null) {
    if (typeof rec.note !== "string") {
      errors.push("note must be a string when present");
    } else {
      note = sanitizeText(rec.note, MAX_NOTE_LENGTH) || null;
    }
  }

  if (errors.length > 0 || !artifactRef || !acceptanceCriteria) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: { workspaceId, fromAgent, toAgent, artifactRef, intent, acceptanceCriteria, note },
  };
}

/** Type guard: is `value` one of the known handoff statuses? */
export function isHandoffStatus(value: unknown): value is HandoffStatus {
  return typeof value === "string" && (HANDOFF_STATUSES as readonly string[]).includes(value);
}

/**
 * Validate a *persisted* contract against the full schema — the gate `accept` runs before honoring a
 * handoff. A record that fails here (e.g. smuggled in around the service, or corrupted) can never be
 * accepted or acted upon. Total — never throws.
 */
export function validateContract(value: unknown): ValidationResult<HandoffContract> {
  const errors: string[] = [];
  const rec = asRecord(value);
  if (!rec) {
    return { ok: false, errors: ["handoff contract must be an object"] };
  }

  // Reuse proposal validation for the structural core, then check the service-stamped fields.
  const core = validateProposal(rec);
  if (!core.ok) {
    errors.push(...core.errors);
  }

  if (typeof rec.id !== "string" || rec.id.trim() === "") {
    errors.push("id is required");
  }
  if (!isHandoffStatus(rec.status)) {
    errors.push("status must be one of: " + HANDOFF_STATUSES.join(", "));
  }
  if (typeof rec.createdAt !== "string" || Number.isNaN(Date.parse(rec.createdAt))) {
    errors.push("createdAt must be an ISO-8601 timestamp");
  }
  if (typeof rec.updatedAt !== "string" || Number.isNaN(Date.parse(rec.updatedAt))) {
    errors.push("updatedAt must be an ISO-8601 timestamp");
  }
  if (!Array.isArray(rec.history) || rec.history.length === 0) {
    errors.push("history must be a non-empty array");
  }

  if (errors.length > 0 || !core.ok) {
    return { ok: false, errors };
  }

  // Every field is validated above; this assembles the typed record from the normalized core + stamps.
  return {
    ok: true,
    value: {
      id: rec.id as string,
      workspaceId: core.value.workspaceId,
      fromAgent: core.value.fromAgent,
      toAgent: core.value.toAgent,
      artifactRef: core.value.artifactRef,
      intent: core.value.intent,
      acceptanceCriteria: core.value.acceptanceCriteria,
      status: rec.status as HandoffStatus,
      note: core.value.note,
      createdAt: rec.createdAt as string,
      updatedAt: rec.updatedAt as string,
      history: rec.history as HandoffContract["history"],
    },
  };
}
