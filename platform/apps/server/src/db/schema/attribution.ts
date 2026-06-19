import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Attributed-revenue ledger (#386, ADR-0386) — the one net-new table. It records an EXPOSURE: a fleet
 * artifact shown to the world under a stable tracking ref (attribution/tracking.ts). It is the head of the
 * causal chain `artifact → exposure → signup → payment`; the signup side already persists as a demand
 * signal (#101) keyed on the recovered ref, and the payment side already persists as a `revenue_events`
 * row (#98 Stripe webhook). Joining the three by tracking ref is the attribution projection.
 *
 * Additive + workspace-scoped (#3, ON DELETE CASCADE). The name is deliberately NOT prefixed
 * tenant_usage, venture_, growth_, demand_ or moat_ so the #155 colocation gate does not class it as a
 * governed metric surface (it is the attribution edge graph, not a metric). Holds NO secret and no money —
 * only an artifact id, a tracking ref, a channel, and timestamps.
 */
export const attributionExposures = pgTable(
  "attribution_exposures",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The fleet artifact this exposure attributes a future payment back to (post id, page path, tweet id).
    // A free-text id (artifacts span many surfaces, not one table), sanitized at the write site.
    artifactId: text("artifact_id").notNull(),
    artifactKind: text("artifact_kind").notNull(), // seo_page | social_post | email | ad | site_pr | ...
    // The stable tracking ref minted for (workspace, artifact, channel) — the join key of the chain.
    trackingRef: text("tracking_ref").notNull(),
    channel: text("channel").notNull(), // seo | social | email | ads | ...
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("attribution_exposures_workspace_idx").on(t.workspaceId, t.occurredAt),
    byArtifact: index("attribution_exposures_artifact_idx").on(t.workspaceId, t.artifactId),
    // One exposure row per (workspace, tracking ref): re-stamping the same artifact is idempotent.
    dedupe: unique("attribution_exposures_ref_uq").on(t.workspaceId, t.trackingRef),
  }),
);
