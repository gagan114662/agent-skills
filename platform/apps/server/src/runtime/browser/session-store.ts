/**
 * Browser session-injection store (#388, ADR-0388) — the PURE seam that supplies a per-workspace,
 * logged-in browser session (Playwright's `storageState`: cookies + per-origin localStorage) into an
 * isolated context, so an agent can operate a site the OWNER is already logged into — with NO API, NO
 * OAuth, and NO in-agent login (the agent never types a credential; {@link BrowserSession.type} keeps
 * `credentialEntry:true` hard-forbidden, ADR-0174 §2).
 *
 * The session blob is a SECRET — it grants live account access — so it MUST live in the #192 owner vault
 * (`external_credentials`, sealed), NEVER in config, env, logs, or receipts. This module is pure: it
 * parses + shape-validates a raw JSON string into a structural {@link BrowserStorageState} and defines
 * the {@link BrowserSessionResolver} seam; the DB-backed resolver (which reads the vault) lives in
 * `db/repositories/browser-session-store.ts`. Playwright is NOT imported here — the shape is declared
 * structurally so this module stays out of the runtime dependency graph and is unit-tested without it.
 *
 * Fail-closed everywhere: a malformed / wrong-shape / empty blob parses to `null`, and a resolver that
 * finds no stored session returns `null` — in both cases the browser falls back to a fresh authless
 * `newContext()` (today's byte-for-byte behavior).
 */

/** One cookie inside a Playwright `storageState`. Structural slice — only the fields we validate. */
export interface BrowserStorageCookie {
  name: string;
  value: string;
  /** Playwright accepts either `domain`+`path` OR `url`; we keep them optional + structural. */
  domain?: string;
  path?: string;
  url?: string;
  [key: string]: unknown;
}

/** One `localStorage` entry for an origin. */
export interface BrowserStorageOriginEntry {
  name: string;
  value: string;
}

/** Per-origin local storage block inside a Playwright `storageState`. */
export interface BrowserStorageOrigin {
  origin: string;
  localStorage: BrowserStorageOriginEntry[];
}

/**
 * The structural shape of Playwright's `storageState` object (cookies[] + origins[] with localStorage).
 * Declared locally (not imported from playwright) so this pure module never pulls the runtime dependency.
 */
export interface BrowserStorageState {
  cookies: BrowserStorageCookie[];
  origins: BrowserStorageOrigin[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Safely parse + shape-validate a raw stored blob into a {@link BrowserStorageState}. Pure and total:
 * NEVER throws — any malformed JSON, missing/!array `cookies`, missing/!array `origins`, or a non-object
 * shape yields `null` (fail-closed → authless fallback). Cookie/origin entries are coerced to the
 * structural slice; entries that are not objects are dropped rather than throwing.
 */
export function parseStorageState(raw: string): BrowserStorageState | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { cookies, origins } = parsed as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(cookies) || !Array.isArray(origins)) return null;

  const safeCookies: BrowserStorageCookie[] = [];
  for (const c of cookies) {
    if (!isRecord(c)) continue;
    if (typeof c.name !== "string" || typeof c.value !== "string") continue;
    safeCookies.push(c as unknown as BrowserStorageCookie);
  }

  const safeOrigins: BrowserStorageOrigin[] = [];
  for (const o of origins) {
    if (!isRecord(o)) continue;
    if (typeof o.origin !== "string") continue;
    const ls = Array.isArray(o.localStorage) ? o.localStorage : [];
    const entries: BrowserStorageOriginEntry[] = [];
    for (const e of ls) {
      if (!isRecord(e)) continue;
      if (typeof e.name !== "string" || typeof e.value !== "string") continue;
      entries.push({ name: e.name, value: e.value });
    }
    safeOrigins.push({ origin: o.origin, localStorage: entries });
  }

  return { cookies: safeCookies, origins: safeOrigins };
}

/**
 * The seam that fetches the stored, logged-in session for a `(workspaceId, target)` pair. The DB-backed
 * implementation reads the #192 vault key `browser_session:<target>` for that workspace and
 * {@link parseStorageState}s it. Returns `null` when absent / malformed so the caller falls back to a
 * fresh authless context (today's behavior). The resolved blob is a secret — callers must NEVER log it.
 */
export interface BrowserSessionResolver {
  resolve(workspaceId: string, target: string): Promise<BrowserStorageState | null>;
}

/** The vault `serviceKey` namespace under which a workspace's per-target session blob is stored. */
export const BROWSER_SESSION_KEY_PREFIX = "browser_session:";

/** The env-var name (inside that vault row) holding the raw Playwright `storageState` JSON. */
export const BROWSER_SESSION_SECRET_FIELD = "STORAGE_STATE";

/** Build the per-target vault `serviceKey` (e.g. `browser_session:x.com`). Lower-cased + trimmed. */
export function browserSessionServiceKey(target: string): string {
  return `${BROWSER_SESSION_KEY_PREFIX}${target.trim().toLowerCase()}`;
}

/** A resolver that always returns `null` (no stored session) — the default, authless fallback. */
export const NULL_BROWSER_SESSION_RESOLVER: BrowserSessionResolver = {
  async resolve(): Promise<BrowserStorageState | null> {
    return null;
  },
};
