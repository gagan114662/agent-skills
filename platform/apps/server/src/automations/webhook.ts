import { createHash, randomBytes } from "node:crypto";

/**
 * Webhook-token helpers for automations (#147, ADR-0147). A webhook automation is fired by POSTing a
 * bearer token to a public route; we store only the **sha-256 hash** (the token is shown once at
 * create, like an API key) so a DB leak never yields a working trigger. Pure `node:crypto`, no deps.
 */

/** The sha-256 hex digest of a webhook token (the stored form). */
export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a fresh webhook token + its stored hash. The token is returned ONCE to the creator. */
export function generateWebhookToken(): { token: string; hash: string } {
  const token = `whk_${randomBytes(24).toString("hex")}`;
  return { token, hash: hashWebhookToken(token) };
}
