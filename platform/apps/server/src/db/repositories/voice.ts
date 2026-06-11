import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../index.js";
import { newId } from "../id.js";
import { supportTickets, voiceInsights } from "../schema/index.js";
import type {
  CreateInsightInput,
  CreateTicketInput,
  InsightStore,
  SupportTicket,
  TicketStore,
  VoiceInsight,
} from "../../voice/service.js";

/**
 * Customer Voice Loop repository (#114, ADR-0114). Workspace-scoped throughout (the #3 IDOR discipline);
 * the pure classify/metrics/digest logic lives in `../../voice/*` — this is persistence only. Implements
 * the {@link TicketStore}/{@link InsightStore} seams the {@link CustomerVoiceService} injects.
 */

const TICKET_COLS = {
  id: supportTickets.id,
  workspaceId: supportTickets.workspaceId,
  ventureIdeaId: supportTickets.ventureIdeaId,
  channel: supportTickets.channel,
  sourceRef: supportTickets.sourceRef,
  contact: supportTickets.contact,
  subject: supportTickets.subject,
  body: supportTickets.body,
  sentiment: supportTickets.sentiment,
  churnRisk: supportTickets.churnRisk,
  category: supportTickets.category,
  status: supportTickets.status,
  draftReply: supportTickets.draftReply,
  replyApprovalRequestId: supportTickets.replyApprovalRequestId,
  triageSessionId: supportTickets.triageSessionId,
  createdByMemberId: supportTickets.createdByMemberId,
  createdAt: supportTickets.createdAt,
  updatedAt: supportTickets.updatedAt,
} as const;

export const dbTicketStore: TicketStore = {
  async create(input: CreateTicketInput) {
    const inserted = await db
      .insert(supportTickets)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        channel: input.channel,
        sourceRef: input.sourceRef,
        contact: input.contact,
        subject: input.subject,
        body: input.body,
        sentiment: input.sentiment,
        churnRisk: input.churnRisk,
        category: input.category,
        status: input.status,
        createdByMemberId: input.createdByMemberId,
      })
      // Idempotent on (workspace, channel, source_ref): a replayed inbound inserts nothing.
      .onConflictDoNothing({
        target: [supportTickets.workspaceId, supportTickets.channel, supportTickets.sourceRef],
      })
      .returning(TICKET_COLS);
    if (inserted.length > 0) return { ticket: inserted[0] as SupportTicket, deduped: false };
    // Conflict: fetch the existing ticket by its unique key.
    const [existing] = await db
      .select(TICKET_COLS)
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.workspaceId, input.workspaceId),
          eq(supportTickets.channel, input.channel),
          eq(supportTickets.sourceRef, input.sourceRef),
        ),
      )
      .limit(1);
    return { ticket: existing as SupportTicket, deduped: true };
  },

  async get(workspaceId, id) {
    const [row] = await db
      .select(TICKET_COLS)
      .from(supportTickets)
      .where(and(eq(supportTickets.id, id), eq(supportTickets.workspaceId, workspaceId)))
      .limit(1);
    return row as SupportTicket | undefined;
  },

  async list(workspaceId, opts) {
    const rows = await db
      .select(TICKET_COLS)
      .from(supportTickets)
      .where(eq(supportTickets.workspaceId, workspaceId))
      .orderBy(desc(supportTickets.createdAt));
    const all = rows as SupportTicket[];
    return opts?.needsHuman ? all.filter((t) => t.status !== "replied" && t.status !== "closed") : all;
  },

  async update(workspaceId, id, patch) {
    const [row] = await db
      .update(supportTickets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(supportTickets.id, id), eq(supportTickets.workspaceId, workspaceId)))
      .returning(TICKET_COLS);
    return row as SupportTicket | undefined;
  },
};

const INSIGHT_COLS = {
  id: voiceInsights.id,
  workspaceId: voiceInsights.workspaceId,
  ventureIdeaId: voiceInsights.ventureIdeaId,
  ticketId: voiceInsights.ticketId,
  kind: voiceInsights.kind,
  sourceKind: voiceInsights.sourceKind,
  sentiment: voiceInsights.sentiment,
  churnRisk: voiceInsights.churnRisk,
  category: voiceInsights.category,
  npsScore: voiceInsights.npsScore,
  summary: voiceInsights.summary,
  sourceRef: voiceInsights.sourceRef,
  createdAt: voiceInsights.createdAt,
} as const;

export const dbInsightStore: InsightStore = {
  async create(input: CreateInsightInput) {
    const inserted = await db
      .insert(voiceInsights)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        ticketId: input.ticketId,
        sourceKind: input.sourceKind,
        sentiment: input.sentiment,
        churnRisk: input.churnRisk,
        category: input.category,
        npsScore: input.npsScore,
        summary: input.summary,
        sourceRef: input.sourceRef,
      })
      // Idempotent on (workspace, source_kind, source_ref). A NULL source_ref is never deduped
      // (Postgres treats NULLs as distinct), so ticket-less anonymous signals always insert.
      .onConflictDoNothing({
        target: [voiceInsights.workspaceId, voiceInsights.sourceKind, voiceInsights.sourceRef],
      })
      .returning(INSIGHT_COLS);
    if (inserted.length > 0 || input.sourceRef === null) {
      // A NULL source_ref never conflicts (NULLs are distinct), so the insert always succeeds for it.
      return { insight: inserted[0] as VoiceInsight, deduped: false };
    }
    const [existing] = await db
      .select(INSIGHT_COLS)
      .from(voiceInsights)
      .where(
        and(
          eq(voiceInsights.workspaceId, input.workspaceId),
          eq(voiceInsights.sourceKind, input.sourceKind),
          eq(voiceInsights.sourceRef, input.sourceRef),
        ),
      )
      .limit(1);
    return { insight: existing as VoiceInsight, deduped: true };
  },

  async list(workspaceId, opts) {
    const filters = [eq(voiceInsights.workspaceId, workspaceId)];
    if (opts?.ventureIdeaId) filters.push(eq(voiceInsights.ventureIdeaId, opts.ventureIdeaId));
    if (opts?.createdAfter) filters.push(gte(voiceInsights.createdAt, opts.createdAfter));
    const rows = await db
      .select(INSIGHT_COLS)
      .from(voiceInsights)
      .where(and(...filters))
      .orderBy(desc(voiceInsights.createdAt));
    return rows as VoiceInsight[];
  },

  async listForIdea(workspaceId, ventureIdeaId) {
    const rows = await db
      .select(INSIGHT_COLS)
      .from(voiceInsights)
      .where(and(eq(voiceInsights.workspaceId, workspaceId), eq(voiceInsights.ventureIdeaId, ventureIdeaId)));
    return rows as VoiceInsight[];
  },
};
