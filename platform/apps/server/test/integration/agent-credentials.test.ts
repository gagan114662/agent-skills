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
});
