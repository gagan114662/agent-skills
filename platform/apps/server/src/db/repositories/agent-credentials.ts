import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { workspaceAgentCredentials } from "../schema/index.js";
import { seal, open, tokenFingerprint, loadEncKey } from "../../crypto/secretbox.js";

/**
 * Per-tenant Claude subscription credentials vault (#68, ADR-0068).
 *
 * A thin repo over `workspace_agent_credentials`. Connecting stores the token SEALED (encrypted at
 * rest when `AGENT_CREDENTIALS_ENC_KEY` is set) + a non-reversible fingerprint. The token is only ever
 * read back to be INJECTED into a runtime (per workspace) — `getCredentialStatus` deliberately never
 * returns it, so a status API can't leak it. Reads are keyed by `workspaceId`, so a token is strictly
 * scoped to its own tenant (the never-pool invariant).
 */

/** What the Settings UI is allowed to know — never the token itself. */
export interface CredentialStatus {
  connected: boolean;
  fingerprint: string | null;
  connectedAt: Date | null;
}

/** Connect (or re-connect) a workspace's Claude subscription token. Last write wins. */
export async function setWorkspaceClaudeToken(input: {
  workspaceId: string;
  token: string;
  connectedByMemberId?: string | null;
}): Promise<CredentialStatus> {
  const key = loadEncKey();
  const sealed = seal(input.token, key);
  const fingerprint = tokenFingerprint(input.token);
  const now = new Date();
  await db
    .insert(workspaceAgentCredentials)
    .values({
      workspaceId: input.workspaceId,
      claudeOauthToken: sealed,
      tokenFingerprint: fingerprint,
      connectedByMemberId: input.connectedByMemberId ?? null,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceAgentCredentials.workspaceId,
      set: {
        claudeOauthToken: sealed,
        tokenFingerprint: fingerprint,
        connectedByMemberId: input.connectedByMemberId ?? null,
        connectedAt: now,
        updatedAt: now,
      },
    });
  return { connected: true, fingerprint, connectedAt: now };
}

/** Resolve a workspace's subscription token (decrypted), or null when none is connected. */
export async function getWorkspaceClaudeToken(workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ token: workspaceAgentCredentials.claudeOauthToken })
    .from(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  return open(row.token, loadEncKey());
}

/** The connected/not-connected state for the Settings UI — never exposes the token. */
export async function getCredentialStatus(workspaceId: string): Promise<CredentialStatus> {
  const [row] = await db
    .select({
      fingerprint: workspaceAgentCredentials.tokenFingerprint,
      connectedAt: workspaceAgentCredentials.connectedAt,
    })
    .from(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId))
    .limit(1);
  if (!row) return { connected: false, fingerprint: null, connectedAt: null };
  return { connected: true, fingerprint: row.fingerprint, connectedAt: row.connectedAt };
}

/** Disconnect a workspace's subscription (idempotent). */
export async function clearWorkspaceClaudeToken(workspaceId: string): Promise<void> {
  await db
    .delete(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId));
}
