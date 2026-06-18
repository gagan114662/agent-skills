import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  setWorkspaceClaudeToken,
  getWorkspaceClaudeToken,
  getCredentialStatus,
  clearWorkspaceClaudeToken,
  recordClaudeAuthFailure,
  getClaudeConnectionHealth,
} from "../../src/db/repositories/agent-credentials.js";

/**
 * #68 — per-tenant Claude subscription credentials vault (real Postgres).
 *
 * Proves the compliance-critical properties: a token round-trips for its own workspace, is strictly
 * scoped per tenant (never readable from another workspace), the status read never exposes the token,
 * and disconnect clears it.
 */
const ids: string[] = [];
async function freshWorkspace(): Promise<string> {
  const id = newId();
  await db.insert(workspaces).values({ id, slug: `cred-${id}`, name: "cred test" });
  ids.push(id);
  return id;
}

beforeAll(async () => {
  // No AGENT_CREDENTIALS_ENC_KEY in CI → transparent pass-through; round-trip still holds.
  delete process.env.AGENT_CREDENTIALS_ENC_KEY;
});

afterAll(async () => {
  if (ids.length) await db.delete(workspaces).where(inArray(workspaces.id, ids));
  await closeDb();
  await closeRedis();
});

describe("agent-credentials vault (#68)", () => {
  it("round-trips a workspace's subscription token", async () => {
    const ws = await freshWorkspace();
    const status = await setWorkspaceClaudeToken({ workspaceId: ws, token: "sk-ant-oat-round" });
    expect(status.connected).toBe(true);
    expect(status.fingerprint).toBeTruthy();
    expect(await getWorkspaceClaudeToken(ws)).toBe("sk-ant-oat-round");
  });

  it("is strictly per-tenant: one workspace's token is never readable from another", async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    await setWorkspaceClaudeToken({ workspaceId: a, token: "token-A" });
    expect(await getWorkspaceClaudeToken(a)).toBe("token-A");
    // B never connected anything — it must resolve to no token, NOT A's token (no pooling).
    expect(await getWorkspaceClaudeToken(b)).toBeNull();
    expect((await getCredentialStatus(b)).connected).toBe(false);
  });

  it("the status read never exposes the raw token", async () => {
    const ws = await freshWorkspace();
    await setWorkspaceClaudeToken({ workspaceId: ws, token: "super-secret-token" });
    const status = await getCredentialStatus(ws);
    expect(JSON.stringify(status)).not.toContain("super-secret-token");
    expect(status).not.toHaveProperty("token");
  });

  it("updates the token on re-connect (last write wins)", async () => {
    const ws = await freshWorkspace();
    await setWorkspaceClaudeToken({ workspaceId: ws, token: "first" });
    await setWorkspaceClaudeToken({ workspaceId: ws, token: "second" });
    expect(await getWorkspaceClaudeToken(ws)).toBe("second");
  });

  it("disconnect clears the token", async () => {
    const ws = await freshWorkspace();
    await setWorkspaceClaudeToken({ workspaceId: ws, token: "to-remove" });
    await clearWorkspaceClaudeToken(ws);
    expect(await getWorkspaceClaudeToken(ws)).toBeNull();
    expect((await getCredentialStatus(ws)).connected).toBe(false);
  });

  // #365 — connection-health signal: connected / not connected / token expired.
  it("reports not_connected for a workspace that never connected", async () => {
    const ws = await freshWorkspace();
    expect((await getClaudeConnectionHealth(ws)).state).toBe("not_connected");
  });

  it("reports connected once a token is in the vault, with no observed failure", async () => {
    const ws = await freshWorkspace();
    await setWorkspaceClaudeToken({ workspaceId: ws, token: "live-token" });
    expect((await getClaudeConnectionHealth(ws)).state).toBe("connected");
    expect((await getCredentialStatus(ws)).lastAuthFailureAt).toBeNull();
  });

  it("flips to expired after an observed auth failure, and back to connected on re-connect", async () => {
    const ws = await freshWorkspace();
    await setWorkspaceClaudeToken({ workspaceId: ws, token: "stale-token" });
    await recordClaudeAuthFailure(ws);
    const expired = await getClaudeConnectionHealth(ws);
    expect(expired.state).toBe("expired");
    expect(expired.reason).toMatch(/reconnect/i);
    // Reconnecting clears the failure marker (last write wins) → healthy again.
    await setWorkspaceClaudeToken({ workspaceId: ws, token: "fresh-token" });
    expect((await getCredentialStatus(ws)).lastAuthFailureAt).toBeNull();
    expect((await getClaudeConnectionHealth(ws)).state).toBe("connected");
  });

  it("recording a failure for a never-connected workspace is a no-op (never fabricates a credential)", async () => {
    const ws = await freshWorkspace();
    await recordClaudeAuthFailure(ws);
    expect((await getCredentialStatus(ws)).connected).toBe(false);
    expect((await getClaudeConnectionHealth(ws)).state).toBe("not_connected");
  });
});
