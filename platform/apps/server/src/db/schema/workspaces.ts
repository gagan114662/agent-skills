import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { newId } from "../id.js";

/** Tenant boundary. Every other table (except global `users`) hangs off a workspace. */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
