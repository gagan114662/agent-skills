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

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | undefined> {
  const [row] = await db
    .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return row;
}
