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
  /** The owner-picked fleet model for this workspace (#246); null ⇒ the deployment default. */
  model: string | null;
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
        // #246: deliberately NOT in the conflict SET — reconnecting a token preserves the owner's model pick.
      },
    });
  // Re-read so the returned status reflects the preserved model pick (#246), never resetting it.
  return getCredentialStatus(input.workspaceId);
}

/** Resolve a workspace's owner-picked fleet model (#246), or null when none is set (use the default). */
export async function getWorkspaceClaudeModel(workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ model: workspaceAgentCredentials.model })
    .from(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId))
    .limit(1);
  return row?.model ?? null;
}

/**
 * Set (or clear, with `null`) a workspace's owner-picked fleet model (#246). The caller validates the
 * model against the models known to resolve BEFORE calling this (so an unservable id never persists).
 * Requires a connected credential row (the picker lives in the connected Connect-Claude panel); returns
 * the updated status, or `null` when the workspace hasn't connected a Claude subscription yet.
 */
export async function setWorkspaceClaudeModel(
  workspaceId: string,
  model: string | null,
): Promise<CredentialStatus | null> {
  const updated = await db
    .update(workspaceAgentCredentials)
    .set({ model, updatedAt: new Date() })
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId))
    .returning({ workspaceId: workspaceAgentCredentials.workspaceId });
  if (updated.length === 0) return null;
  return getCredentialStatus(workspaceId);
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
      model: workspaceAgentCredentials.model,
    })
    .from(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId))
    .limit(1);
  if (!row) return { connected: false, fingerprint: null, connectedAt: null, model: null };
  return { connected: true, fingerprint: row.fingerprint, connectedAt: row.connectedAt, model: row.model };
}

/** Disconnect a workspace's subscription (idempotent). */
export async function clearWorkspaceClaudeToken(workspaceId: string): Promise<void> {
  await db
    .delete(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId));
}
