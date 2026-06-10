import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { workspaces } from "../schema/index.js";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
}

export async function createWorkspace(input: { slug: string; name: string }): Promise<Workspace> {
  const [row] = await db
    .insert(workspaces)
    .values({ slug: input.slug, name: input.name })
    .returning({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name });
  return row!;
}

/**
 * All workspace ids (the SRE Loop's #112 work-list — it still gates each on `sre.enabled`, so an
 * un-opted-in workspace is a no-op). Cheap: a single indexed-pk scan, only walked when the opt-in SRE
 * timer is running.
 */
export async function listWorkspaceIds(): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces);
  return rows.map((r) => r.id);
}

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | undefined> {
  const [row] = await db
    .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return row;
}
