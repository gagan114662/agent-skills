import { asc, and, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "../index.js";
import { workspaceAgentCredentials } from "../schema/index.js";
import { seal, open, tokenFingerprint, loadEncKey } from "../../crypto/secretbox.js";
import { assertModelLaunchable } from "../../runtime/models.js";
import type { WorkspaceModelRow } from "../../runtime/model-backfill.js";
import {
  deriveClaudeConnectionHealth,
  type ClaudeConnectionHealthResult,
} from "../../auth/claude-connect-health.js";

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
  /**
   * When a real agent launch last OBSERVED this workspace's stored credential as unusable (#365), or null
   * when none observed. Drives the `expired` connection-health state. Never a token — only a timestamp.
   */
  lastAuthFailureAt: Date | null;
}

export const MAX_WORKSPACE_MODEL_OVERRIDE_BATCH = 500;

export function clampWorkspaceModelOverrideBatch(limit?: number): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) return MAX_WORKSPACE_MODEL_OVERRIDE_BATCH;
  return Math.min(MAX_WORKSPACE_MODEL_OVERRIDE_BATCH, Math.floor(limit));
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
        // #365: a (re)connect clears any prior observed auth failure (last write wins) so the health
        // signal flips back to `connected` immediately — reversible, never a sticky false "expired".
        lastAuthFailureAt: null,
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
 * Set (or clear, with `null`) a workspace's owner-picked fleet model (#246). Requires a connected
 * credential row (the picker lives in the connected Connect-Claude panel); returns the updated status,
 * or `null` when the workspace hasn't connected a Claude subscription yet.
 *
 * GUARD (#293): a non-null model is validated against the models known to resolve at the PERSISTENCE
 * boundary — `assertModelLaunchable` throws {@link ModelUnavailableError} for an unservable id. The HTTP
 * route validates first (returning a 400), so this is defense-in-depth: it makes "a workspace pinned to
 * an unavailable model" unrepresentable no matter which caller writes it, which is exactly the class of
 * bug the backfill exists to clean up. `null` (clear the override) is always allowed.
 */
export async function setWorkspaceClaudeModel(
  workspaceId: string,
  model: string | null,
): Promise<CredentialStatus | null> {
  if (model !== null) assertModelLaunchable(model);
  const updated = await db
    .update(workspaceAgentCredentials)
    .set({ model, updatedAt: new Date() })
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId))
    .returning({ workspaceId: workspaceAgentCredentials.workspaceId });
  if (updated.length === 0) return null;
  return getCredentialStatus(workspaceId);
}

/**
 * Every workspace's stored model override (#293 backfill: the rows the repair inspects). Reads only the
 * non-secret `model` column for rows that actually set one (`model IS NOT NULL`) — a null override needs
 * no repair, so it is excluded to keep the scan small.
 */
export async function listWorkspaceModelOverrides(options: {
  afterWorkspaceId?: string;
  limit?: number;
} = {}): Promise<WorkspaceModelRow[]> {
  const where = [isNotNull(workspaceAgentCredentials.model)];
  if (options.afterWorkspaceId) where.push(gt(workspaceAgentCredentials.workspaceId, options.afterWorkspaceId));
  const rows = await db
    .select({ workspaceId: workspaceAgentCredentials.workspaceId, model: workspaceAgentCredentials.model })
    .from(workspaceAgentCredentials)
    .where(and(...where))
    .orderBy(asc(workspaceAgentCredentials.workspaceId))
    .limit(clampWorkspaceModelOverrideBatch(options.limit));
  return rows.map((r) => ({ workspaceId: r.workspaceId, model: r.model }));
}

/**
 * Persist one backfill repair (#293): set a workspace's override to a (servable) model. Distinct from
 * {@link setWorkspaceClaudeModel} only in intent/logging — it shares the same launchability guard, so the
 * backfill can never itself write an unservable value. The target is always the managed default, which is
 * servable, so the guard never fires here in practice; it stays as a safety net.
 */
export async function backfillWorkspaceModel(workspaceId: string, model: string): Promise<void> {
  assertModelLaunchable(model);
  await db
    .update(workspaceAgentCredentials)
    .set({ model, updatedAt: new Date() })
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId));
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
      lastAuthFailureAt: workspaceAgentCredentials.lastAuthFailureAt,
    })
    .from(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId))
    .limit(1);
  if (!row) {
    return { connected: false, fingerprint: null, connectedAt: null, model: null, lastAuthFailureAt: null };
  }
  return {
    connected: true,
    fingerprint: row.fingerprint,
    connectedAt: row.connectedAt,
    model: row.model,
    lastAuthFailureAt: row.lastAuthFailureAt,
  };
}

/**
 * The owner-facing connection health (#365) — connected / not connected / token expired — derived purely
 * from the vault, with NO live call and NO token access. The single source of truth the `/me/claude/health`
 * route and the console chip read, so what the owner sees can never disagree with what the runtime would do.
 */
export async function getClaudeConnectionHealth(
  workspaceId: string,
): Promise<ClaudeConnectionHealthResult> {
  const status = await getCredentialStatus(workspaceId);
  return deriveClaudeConnectionHealth({
    connected: status.connected,
    connectedAt: status.connectedAt,
    lastAuthFailureAt: status.lastAuthFailureAt,
  });
}

/**
 * Record that a real agent launch OBSERVED this workspace's stored credential as unusable (#365) — a
 * removed/blanked/undecryptable token despite a connected row. Stamps `last_auth_failure_at`, which flips
 * the health signal to `expired` (reconnect clears it). A pure UPDATE scoped to an EXISTING row: it never
 * inserts, so an unconnected workspace stays `not_connected` and this never fabricates a credential. Never
 * touches the token. Idempotent — re-stamping is harmless.
 */
export async function recordClaudeAuthFailure(workspaceId: string): Promise<void> {
  const now = new Date();
  await db
    .update(workspaceAgentCredentials)
    .set({ lastAuthFailureAt: now, updatedAt: now })
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId));
}

/** Disconnect a workspace's subscription (idempotent). */
export async function clearWorkspaceClaudeToken(workspaceId: string): Promise<void> {
  await db
    .delete(workspaceAgentCredentials)
    .where(eq(workspaceAgentCredentials.workspaceId, workspaceId));
}
