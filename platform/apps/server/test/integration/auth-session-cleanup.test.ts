import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { newId } from "../../src/db/id.js";
import { sessions, users, workspaces } from "../../src/db/schema/index.js";
import {
  createHumanAccount,
  createSession,
  deleteExpiredSessions,
} from "../../src/db/repositories/auth.js";

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
const createdTokenHashes: string[] = [];

afterAll(async () => {
  if (createdTokenHashes.length > 0) {
    await db.delete(sessions).where(inArray(sessions.tokenHash, createdTokenHashes));
  }
  if (createdWorkspaceIds.length > 0) {
    await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaceIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await closeDb();
});

describe("auth session cleanup repository (#960)", () => {
  it("deletes expired human sessions in a bounded cleanup while retaining valid rows", async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ slug: `auth-cleanup-${newId()}`, name: "auth cleanup" })
      .returning({ id: workspaces.id });
    createdWorkspaceIds.push(ws!.id);
    const { userId } = await createHumanAccount({
      workspaceId: ws!.id,
      email: `cleanup-${newId()}@example.com`,
      passwordHash: "test-hash",
      displayName: "Cleanup User",
    });
    createdUserIds.push(userId);
    const now = new Date("2000-01-01T00:00:00.000Z");
    const expiredOld = `expired-old-${newId()}`;
    const expiredNow = `expired-now-${newId()}`;
    const valid = `valid-${newId()}`;
    createdTokenHashes.push(expiredOld, expiredNow, valid);
    await createSession({ userId, tokenHash: expiredOld, expiresAt: new Date("1999-12-31T23:58:00.000Z") });
    await createSession({ userId, tokenHash: expiredNow, expiresAt: now });
    await createSession({ userId, tokenHash: valid, expiresAt: new Date("2000-01-01T00:01:00.000Z") });

    await expect(deleteExpiredSessions({ now, limit: 100 })).resolves.toBe(2);
    const remaining = await db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(inArray(sessions.tokenHash, [expiredOld, expiredNow, valid]));
    expect(remaining.map((row) => row.tokenHash)).toEqual([valid]);
  });
});
