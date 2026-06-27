import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { members } from "./identities.js";
import { workspaces } from "./workspaces.js";

/** Per-member Apple Messages destination. Pending rows are not treated as connected until a real send works. */
export const imessageRecipients = pgTable(
  "imessage_recipients",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    recipient: text("recipient").notNull(),
    serviceName: text("service_name"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memberUnique: uniqueIndex("imessage_recipients_member_uidx").on(t.workspaceId, t.memberId),
  }),
);
