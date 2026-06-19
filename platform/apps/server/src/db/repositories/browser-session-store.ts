import { resolveServiceSecrets } from "./external-credentials.js";
import {
  parseStorageState,
  browserSessionServiceKey,
  BROWSER_SESSION_SECRET_FIELD,
  type BrowserSessionResolver,
  type BrowserStorageState,
} from "../../runtime/browser/session-store.js";

/**
 * DB-backed {@link BrowserSessionResolver} (#388, ADR-0388) — reads a workspace's stored, logged-in
 * browser session from the #192 owner vault and returns it as a parsed Playwright `storageState`.
 *
 * The session blob is a SECRET (it grants live account access), so it is stored SEALED in
 * `external_credentials` under the per-target service key `browser_session:<target>` (one row per
 * workspace+target) with the raw JSON under the `STORAGE_STATE` field, and read back ONLY through
 * {@link resolveServiceSecrets} — the existing per-workspace, never-pooled vault read-back path (it is
 * never selected by any status/list API, so a key cannot leak to a user). Reuses the existing vault
 * mechanism, so NO new table / migration is required.
 *
 * Fail-closed: an absent row, a revoked credential, a missing field, or a malformed blob all resolve to
 * `null`, so the browser falls back to a fresh authless context (today's behavior). The resolved
 * `storageState` is a secret — callers MUST NOT log it (it never enters receipts/logs by construction;
 * the session only records tool/url/detail, never page content or the injected state).
 */
export function createDbBrowserSessionResolver(): BrowserSessionResolver {
  return {
    async resolve(workspaceId: string, target: string): Promise<BrowserStorageState | null> {
      const serviceKey = browserSessionServiceKey(target);
      const secrets = await resolveServiceSecrets(workspaceId, serviceKey);
      const raw = secrets[BROWSER_SESSION_SECRET_FIELD];
      if (typeof raw !== "string" || raw === "") return null;
      return parseStorageState(raw);
    },
  };
}
