import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { tasks } from "./tasks.js";
import { approvalRequests } from "./approvals.js";
import { memories } from "./stubs.js";

/**
 * The shared **decision store** (issue #513) — the system of record that lets the fleet's agents capture
 * the decisions they make and reuse the ones their teammates made before, instead of re-deriving context
 * every run. It is the structured, queryable spine the #15/#16 memory graph lacked for *decisions*: each
 * row is a first-class decision (topic + title + rationale + who) that an agent recalls by topic before
 * deciding, and every row mirrors into a browsable `decision` node in the #15 graph (`memory_id`).
 *
 * Workspace-scoped (#3, ON DELETE CASCADE). Holds NO secret and NO money: a decision is a *record*, never
 * an action — anything external/money it implies is parked behind the #13 approval gate and referenced
 * here via `approval_request_id` (NULL for an ordinary internal decision). `rationale`/`title` are
 * sanitized at the write site so a decision brief never leaks internal agent chatter (#200, the user-facing
 * output rule). Re-recording the same decision is idempotent via `(workspace_id, dedupe_key)`.
 *
 * The name is deliberately NOT tenant_usage / venture_ / growth_ / demand_ / moat_ -prefixed so the #155
 * colocation gate does not class it as a governed metric surface — it is a memory/CRM-style record store,
 * not a metric. Numbered 0503 by the next free prefix in the shared migration sequence.
 */
export const AGENT_DECISION_STATUSES = ["recorded", "superseded"] as const;
export type AgentDecisionStatus = (typeof AGENT_DECISION_STATUSES)[number];

export const agentDecisions = pgTable(
  "agent_decisions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The subject an agent decides about (a brand/channel/product/topic) — the recall key, normalized. */
    topic: text("topic").notNull(),
    /** The decision itself, one line — sanitized + length-capped at the write site (no agent chatter). */
    title: text("title").notNull(),
    /** Why the decision was made — sanitized + length-capped at the write site. */
    rationale: text("rationale").notNull(),
    /** The member (agent or human) who decided. Kept on member delete for an auditable trail. */
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: AGENT_DECISION_STATUSES }).notNull().default("recorded"),
    /** Mirror into the #15 browsable graph: the `decision` node this row was captured as. */
    memoryId: uuid("memory_id").references(() => memories.id, { onDelete: "set null" }),
    /** Optional #14 task this decision was made in service of. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** When the decision implies an external/money action, the #13 request it is parked behind. */
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "set null",
    }),
    /** Set ⇒ a newer decision replaced this one (kept, not deleted — version history, mirrors #16). */
    supersededByDecisionId: uuid("superseded_by_decision_id").references(
      (): AnyPgColumn => agentDecisions.id,
      { onDelete: "set null" },
    ),
    /** sha256(topic, title) — `UNIQUE (workspace_id, dedupe_key)` turns a re-record into a merge. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    dedupeUniq: unique("agent_decisions_dedupe_uniq").on(t.workspaceId, t.dedupeKey),
    byTopic: index("agent_decisions_topic_idx").on(t.workspaceId, t.topic),
    // the default "live decisions" path filters on this; partial index keeps it cheap per workspace.
    live: index("agent_decisions_live_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.supersededByDecisionId} IS NULL`),
  }),
);
