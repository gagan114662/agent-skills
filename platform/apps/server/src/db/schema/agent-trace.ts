import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { agentSessions } from "./agent-sessions.js";
import { members } from "./identities.js";
import { tasks } from "./tasks.js";

/**
 * The unified **observation/replay trace** (issue #560) — the single per-run record of what each agent
 * actually SAW and DID. Observation today is partial (dr/verify readback receipts #200, evals, release
 * receipts); these two tables close the gap with an append-only event log per agent run capturing every
 * model request (system+messages+tools), every response (incl reasoning), every tool call+result, and
 * every #13 approval-gate decision — with timestamps and token/cost — so any run can be opened and
 * REPLAYED to reconstruct the exact context the model saw at each turn and every action it took.
 *
 * Workspace-scoped (#3, ON DELETE CASCADE). Holds NO live secret: every event `payload` is run through the
 * #25 secret redactor (`runtime/redact.ts`) plus a key-scrubber at the write site (`trace/redact.ts`)
 * before it is persisted, so a trace can never become a secret-exfil channel (#25 boundary, #200). The
 * name is deliberately NOT a governed-metric prefix so the #155 colocation gate treats it as the
 * observability log it is, not a metric surface. Numbered 0506 by the next free prefix (0505 was taken by two sibling features).
 */

/** A trace event kind. The five things worth replaying about an autonomous run. */
export const AGENT_TRACE_EVENT_TYPES = [
  "model_request",
  "model_response",
  "tool_call",
  "tool_result",
  "approval_decision",
] as const;
export type AgentTraceEventType = (typeof AGENT_TRACE_EVENT_TYPES)[number];

export const AGENT_TRACE_RUN_STATUSES = ["open", "closed"] as const;
export type AgentTraceRunStatus = (typeof AGENT_TRACE_RUN_STATUSES)[number];

/** One row per agent run: the trace header + replay-ordering counter + token/cost rollup. */
export const agentTraceRuns = pgTable(
  "agent_trace_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The #25 agent_sessions run this traces, when one exists (a trace can also be opened standalone). */
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    /** The agent the run belongs to. Kept on member delete for an auditable trail. */
    agentMemberId: uuid("agent_member_id").references(() => members.id, { onDelete: "set null" }),
    /** Optional #14 task this run served. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    label: text("label"),
    status: text("status", { enum: AGENT_TRACE_RUN_STATUSES }).notNull().default("open"),
    /** Monotonic source for the next event's `seq`, bumped atomically as each event is appended. */
    nextSeq: integer("next_seq").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("agent_trace_runs_ws_idx").on(t.workspaceId, t.startedAt),
    bySession: index("agent_trace_runs_session_idx").on(t.sessionId),
  }),
);

/**
 * Append-only event log: every model request/response, tool call/result, and approval decision, in order.
 * Rows are inserted and never updated — `seq` (unique within a run) is the total replay order; `turn`
 * groups a request with the response and tool calls it produced. `payload` is the structured content,
 * ALREADY redacted at the write site.
 */
export const agentTraceEvents = pgTable(
  "agent_trace_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentTraceRuns.id, { onDelete: "cascade" }),
    /** Denormalized for the #3 IDOR scope (every read filters by workspace_id). */
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type", { enum: AGENT_TRACE_EVENT_TYPES }).notNull(),
    /** Logical turn index — a request + its response + the tools it called share a turn. */
    turn: integer("turn").notNull().default(0),
    label: text("label"),
    /** The structured, ALREADY-REDACTED content (messages, tool args/result, reasoning, decision). */
    payload: jsonb("payload").notNull().default({}),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUniq: unique("agent_trace_events_seq_uniq").on(t.runId, t.seq),
    replay: index("agent_trace_events_replay_idx").on(t.workspaceId, t.runId, t.seq),
  }),
);
