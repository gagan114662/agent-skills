import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createWorkspace } from "../../src/db/repositories/workspaces.js";
import { createHumanMember } from "../../src/db/repositories/members.js";
import { listChannels } from "../../src/db/repositories/channels.js";
import { listPersonas } from "../../src/db/repositories/personas.js";
import { backfillMarketingDepartments } from "../../src/marketing/default.js";
import { MARKETING_CHANNELS } from "../../src/marketing/blueprint.js";

/**
 * #138 — boot backfill against real Postgres.
 *
 * Proves the owner's acceptance criterion: a workspace that predates the fleet being turned on (created
 * directly, never seeded on signup) gets its full agency — the seven department channels + two shared
 * rooms + seven named agents — when the backfill sweeps on boot. And that the sweep is idempotent (a
 * second boot creates nothing new), and is a no-op when marketing is disabled for the tenant.
 */
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const slugs: string[] = [];

beforeAll(() => {
  // The deployment env that ipop.ai's fly.toml sets — this is what flips the per-workspace gate on.
  process.env.RELOAD_MARKETING_ENABLED = "true";
  process.env.RELOAD_MARKETING_SEED_WELCOME_TASKS = "false";
});

afterAll(async () => {
  delete process.env.RELOAD_MARKETING_ENABLED;
  delete process.env.RELOAD_MARKETING_SEED_WELCOME_TASKS;
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function preExistingWorkspace(): Promise<string> {
  const slug = `bf-${newId()}`;
  slugs.push(slug);
  const ws = await createWorkspace({ slug, name: slug });
  // A human owner, but NO channels — exactly the shape of a workspace created before the fleet existed.
  await createHumanMember({ workspaceId: ws.id, email: `u-${newId()}@e.com`, displayName: "Owner" });
  return ws.id;
}

describe("#138 marketing department backfill (real Postgres)", () => {
  it("backfills the full agency for a pre-existing workspace, and is idempotent", async () => {
    const workspaceId = await preExistingWorkspace();
    expect(await listChannels(workspaceId)).toHaveLength(0); // starts empty

    await backfillMarketingDepartments(silentLog as never);

    const channels = await listChannels(workspaceId);
    expect(channels.map((c) => c.name).sort()).toEqual([...MARKETING_CHANNELS].sort());
    const personas = await listPersonas(workspaceId);
    expect(personas.map((p) => p.name).sort()).toEqual(["bid", "comet", "echo", "lens", "mark", "postmark", "quill", "scout"]);

    // Idempotent: a second boot sweep creates no duplicate channels or personas.
    await backfillMarketingDepartments(silentLog as never);
    expect(await listChannels(workspaceId)).toHaveLength(MARKETING_CHANNELS.length);
    expect(await listPersonas(workspaceId)).toHaveLength(8);
  });

  it("is a no-op for a workspace where marketing is disabled", async () => {
    const workspaceId = await preExistingWorkspace();
    process.env.RELOAD_MARKETING_ENABLED = "false";
    try {
      await backfillMarketingDepartments(silentLog as never);
      expect(await listChannels(workspaceId)).toHaveLength(0);
    } finally {
      process.env.RELOAD_MARKETING_ENABLED = "true";
    }
  });
});
