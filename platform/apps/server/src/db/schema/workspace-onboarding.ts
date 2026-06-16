import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Non-technical onboarding state (#260): the one screen is "enter your domain → Sign in with Google".
 *
 * A workspace is created/attached by the Google OAuth callback, but the typed domain (the thing the user
 * actually entered) and the post-signin bootstrap status have nowhere durable to live — `marketing.siteUrl`
 * is config-only (read-only at runtime). This per-tenant row persists both:
 *
 *  - `domain` — the customer's own site, normalised to a bare host (e.g. `acme.com`). Scout's verify /
 *    sitemap brief is fired against it, and it is the seed for `{{site}}` reconciliation (#250/#258).
 *  - `bootstrapped_at` — set once the post-signin bootstrap (seed fleet + kick Scout) has run, so a
 *    re-login never re-fires it. One row per workspace (PK = workspace_id, last write wins).
 *
 * No secret lives here — the Google tokens are sealed in the #192 vault under service_key `google`.
 */
export const workspaceOnboarding = pgTable("workspace_onboarding", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** The bare host the user typed (e.g. `acme.com`); null until they enter one. */
  domain: text("domain"),
  /** Set once the post-signin bootstrap (seed + Scout brief) has run; null = not yet bootstrapped. */
  bootstrappedAt: timestamp("bootstrapped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
