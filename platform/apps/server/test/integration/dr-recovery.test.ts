import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "../../src/app.js";
import { db, closeDb, getPool } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { setMaintenance } from "../../src/maintenance/flag.js";
import { LocalDirObjectStore } from "../../src/dr/object-store.js";
import { pgToolsAvailable, dumpDatabase } from "../../src/dr/dump.js";
import { runValidationDrill } from "../../src/dr/runbook.js";
import { loadEnv } from "../../src/env.js";

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  // Never leave the global flag on for the next test file.
  await setMaintenance(false, {}).catch(() => undefined);
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

interface Owner {
  cookie: string;
  workspaceId: string;
}

async function newOwner(prefix: string): Promise<Owner> {
  const slug = `${prefix}-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId };
}

describe("maintenance mode rejects writes but never reads (#99)", () => {
  it("503s a write while maintenance is ON, allows reads, and resumes when flipped OFF", async () => {
    // Create the owner BEFORE maintenance (signup is itself a write).
    const owner = await newOwner("dr-maint");

    // A write succeeds when maintenance is off.
    const before = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/channels`,
      cookies: { rid: owner.cookie },
      payload: { name: `before-${newId()}` },
    });
    expect(before.statusCode).toBeLessThan(400);

    // Flip maintenance ON via the control route (it is allow-listed, so this write is permitted).
    const on = await app.inject({
      method: "POST",
      url: "/maintenance",
      cookies: { rid: owner.cookie },
      payload: { on: true, reason: "drill" },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().enabled).toBe(true);

    try {
      // A write is now rejected with 503 + Retry-After.
      const blocked = await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/channels`,
        cookies: { rid: owner.cookie },
        payload: { name: `blocked-${newId()}` },
      });
      expect(blocked.statusCode).toBe(503);
      expect(blocked.headers["retry-after"]).toBeTruthy();

      // Reads still work during maintenance.
      const read = await app.inject({ method: "GET", url: "/me", cookies: { rid: owner.cookie } });
      expect(read.statusCode).toBe(200);

      // Status route reports enabled.
      const status = await app.inject({ method: "GET", url: "/maintenance", cookies: { rid: owner.cookie } });
      expect(status.json().enabled).toBe(true);
    } finally {
      // Flip OFF (control route allow-listed even while ON).
      const off = await app.inject({
        method: "POST",
        url: "/maintenance",
        cookies: { rid: owner.cookie },
        payload: { on: false },
      });
      expect(off.statusCode).toBe(200);
      expect(off.json().enabled).toBe(false);
    }

    // Writes resume once maintenance is off.
    const after = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/channels`,
      cookies: { rid: owner.cookie },
      payload: { name: `after-${newId()}` },
    });
    expect(after.statusCode).toBeLessThan(400);
  });
});

describe("VALIDATION drill: dump → restore → verify into a throwaway DB (#99)", () => {
  it("restores the latest dump from a fake bucket and verifies counts + schema + freshness + checksums", async () => {
    if (!(await pgToolsAvailable())) {
      console.warn("dr-recovery: pg_dump/psql not available — skipping the restore drill");
      return;
    }

    // Seed a known row so the anchor table is non-empty and content-checksummed.
    await newOwner("dr-drill");

    const sourceUrl = loadEnv().databaseUrl;
    const bucketDir = await mkdtemp(join(tmpdir(), "dr-bucket-"));
    const store = new LocalDirObjectStore(bucketDir);

    // 1) Dump the live DB and "upload" it to the fake bucket.
    const dumpPath = join(bucketDir, `reload-${Date.now()}.sql.gz`);
    const dump = await dumpDatabase(sourceUrl, dumpPath);
    expect(dump.bytes).toBeGreaterThan(0);
    await store.put(`dumps/reload-${Date.now()}.sql.gz`, dumpPath);

    // 2) Create a throwaway target DB.
    const throwaway = `reload_dr_drill_${Date.now()}`;
    await getPool().query(`CREATE DATABASE ${throwaway}`);
    const throwawayUrl = sourceUrl.replace(/\/[^/]+$/, `/${throwaway}`);

    try {
      // 3) Run the drill: download latest → restore → verify (non-destructive).
      const report = await runValidationDrill({
        store,
        prefix: "dumps/",
        sourceUrl,
        throwawayUrl,
        anchorTables: ["workspaces", "_migrations"],
      });

      expect(report.ok).toBe(true);
      expect(report.countMismatches).toEqual([]);
      expect(report.checksumMismatches).toEqual([]);
      expect(report.missingTables).toEqual([]);
    } finally {
      // Drop the throwaway (terminate any lingering backends first).
      const admin = new pg.Client({ connectionString: sourceUrl });
      await admin.connect();
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [throwaway],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${throwaway}`);
      await admin.end();
      await rm(bucketDir, { recursive: true, force: true });
    }
  });
});
