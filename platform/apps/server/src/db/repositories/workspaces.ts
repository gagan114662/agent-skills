import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { workspaces } from "../schema/index.js";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  billingEmail: string | null;
  stripeCustomerId: string | null;
}

export async function createWorkspace(input: {
  slug: string;
  name: string;
  timezone?: string;
}): Promise<Workspace> {
  const [row] = await db
    .insert(workspaces)
    .values({ slug: input.slug, name: input.name, timezone: input.timezone ?? "UTC" })
    .returning({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      timezone: workspaces.timezone,
      billingEmail: workspaces.billingEmail,
      stripeCustomerId: workspaces.stripeCustomerId,
    });
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
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      timezone: workspaces.timezone,
      billingEmail: workspaces.billingEmail,
      stripeCustomerId: workspaces.stripeCustomerId,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return row;
}

export async function updateWorkspaceBillingContact(input: {
  workspaceId: string;
  billingEmail?: string | null;
  stripeCustomerId?: string | null;
}): Promise<Workspace | undefined> {
  const values: Partial<typeof workspaces.$inferInsert> = {};
  if (input.billingEmail !== undefined) values.billingEmail = input.billingEmail;
  if (input.stripeCustomerId !== undefined) values.stripeCustomerId = input.stripeCustomerId;
  if (Object.keys(values).length === 0) return undefined;
  const [row] = await db
    .update(workspaces)
    .set(values)
    .where(eq(workspaces.id, input.workspaceId))
    .returning({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      timezone: workspaces.timezone,
      billingEmail: workspaces.billingEmail,
      stripeCustomerId: workspaces.stripeCustomerId,
    });
  return row;
}

export async function getWorkspaceTimeZone(workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.timezone || "UTC";
}
