/**
 * Production wiring for the #660 connector OAuth refresher.
 *
 * Kept SEPARATE from `oauth-refresh.ts` so the pure/seam-driven module imports no DB and no network and
 * can be unit-tested in isolation. This file binds the real seams: the #192 vault read-back, a
 * scope-preserving re-seal, and the live Google OAuth client. Returns `null` when the deployment has no
 * Google OAuth app configured (the feature degrades honestly, exactly like the connect routes).
 */

import { createGoogleOAuthClient } from "../auth/google-client.js";
import {
  GOOGLE_CONNECTION_SERVICE_KEY,
  loadGoogleOAuthConfig,
} from "../auth/google-oauth.js";
import {
  resolveServiceSecrets,
  setServiceCredentials,
  getServiceStatus,
} from "../db/repositories/external-credentials.js";
import { GoogleTokenRefresher } from "./oauth-refresh.js";

/**
 * Build a {@link GoogleTokenRefresher} bound to the live vault + Google client for a workspace's `google`
 * connection, or null when Google OAuth isn't configured. The re-seal preserves the connection's recorded
 * scopes (read from the status row) so a refresh never silently narrows what was granted.
 */
export function createGoogleTokenRefresher(
  env: NodeJS.ProcessEnv = process.env,
): GoogleTokenRefresher | null {
  const config = loadGoogleOAuthConfig(env);
  if (!config) return null;
  const client = createGoogleOAuthClient(config);
  return new GoogleTokenRefresher({
    readSecrets: (workspaceId) =>
      resolveServiceSecrets(workspaceId, GOOGLE_CONNECTION_SERVICE_KEY),
    writeSecrets: async (workspaceId, secrets) => {
      const status = await getServiceStatus(workspaceId, GOOGLE_CONNECTION_SERVICE_KEY);
      await setServiceCredentials({
        workspaceId,
        serviceKey: GOOGLE_CONNECTION_SERVICE_KEY,
        secrets,
        // Preserve the connection's granted scopes across a refresh re-seal (never downgrade).
        scopes: status?.scopes ?? [],
        rotationReminderDays: status?.rotationReminderDays ?? 0,
      });
    },
    refresh: (refreshToken) => client.refreshAccessToken(refreshToken),
  });
}
