import type { AgentDecisionRow } from "../db/repositories/agent-decisions.js";
import {
  composePriorDecisionsBlock,
  decisionDedupeKey,
  formatDecisionBrief,
  normalizeTopic,
  sanitizeDecisionText,
} from "./recall.js";
import type {
  DecisionRecall,
  RecalledDecision,
  RecordDecisionRequest,
  RecordedDecision,
} from "./types.js";

/**
 * The decision-store service (issue #513): the one place that turns a raw "an agent decided X" into a
 * sanitized, deduplicated, governable record. Pure with injected IO seams (`DecisionDeps`) — unit-tested
 * with fakes; `decisions/default.ts` binds the seams to the real repos. Routes and the agent run-loop call
 * this, never the repo directly, so sanitization (#200 user-facing rule) and the #13 approval gate for
 * external/money actions can never be bypassed.
 */

/** Persist a decision row (dedup key + links resolved by the service). */
export type RecordDecisionPersist = {
  workspaceId: string;
  topic: string;
  title: string;
  rationale: string;
  dedupeKey: string;
  decidedByMemberId: string | null;
  memoryId: string | null;
  taskId: string | null;
  approvalRequestId: string | null;
};

export interface DecisionDeps {
  record(input: RecordDecisionPersist): Promise<{ id: string; created: boolean }>;
  supersede(
    input: RecordDecisionPersist & { oldId: string },
  ): Promise<{ newId: string; created: boolean; superseded: boolean }>;
  getDecision(workspaceId: string, id: string): Promise<AgentDecisionRow | undefined>;
  listDecisions(
    workspaceId: string,
    filter: { topic?: string; includeSuperseded?: boolean; limit?: number },
  ): Promise<AgentDecisionRow[]>;
  recallDecisions(
    workspaceId: string,
    query: { topic?: string; limit?: number },
  ): Promise<AgentDecisionRow[]>;
  /** Mirror a decision into the #15 browsable graph as a `decision` node; returns the node id. */
  mirrorToMemory(input: {
    workspaceId: string;
    topic: string;
    title: string;
    rationale: string;
    dedupeKey: string;
    sourceId: string | null;
    createdByMemberId: string | null;
  }): Promise<string>;
  /** Park an external/money action behind the #13 gate (status pending); returns the request id. */
  parkApproval(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionType: string;
    amount: number | null;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<string>;
  /** Best-effort #14 link from the decision's memory node to its task. */
  linkTaskMemory?(input: {
    workspaceId: string;
    taskId: string;
    memoryId: string;
    createdByMemberId: string;
  }): Promise<void>;
}

function toRecalled(row: AgentDecisionRow): RecalledDecision {
  return {
    id: row.id,
    topic: row.topic,
    title: row.title,
    rationale: row.rationale,
    decidedAt: row.createdAt,
  };
}

export class DecisionService {
  constructor(private readonly deps: DecisionDeps) {}

  /**
   * Record a decision: sanitize the user-facing fields, mirror it into the #15 graph, park any implied
   * external/money action behind the #13 gate, then persist (idempotent on topic+title). The decision is
   * always recorded; only its implied action waits on approval — `pendingApproval` says which.
   */
  async record(req: RecordDecisionRequest): Promise<RecordedDecision> {
    const topic = normalizeTopic(req.topic);
    const title = sanitizeDecisionText(req.title);
    const rationale = sanitizeDecisionText(req.rationale, 600);
    const key = decisionDedupeKey(topic, title);

    const memoryId = await this.deps.mirrorToMemory({
      workspaceId: req.workspaceId,
      topic,
      title,
      rationale,
      dedupeKey: key,
      sourceId: req.taskId ?? null,
      createdByMemberId: req.decidedByMemberId,
    });

    let approvalRequestId: string | null = null;
    if (req.external) {
      approvalRequestId = await this.deps.parkApproval({
        workspaceId: req.workspaceId,
        requesterMemberId: req.decidedByMemberId,
        actionType: req.external.actionType,
        amount: req.external.amount,
        summary: sanitizeDecisionText(req.external.summary, 280),
        payload: { ...(req.external.payload ?? {}), decisionTopic: topic, decisionTitle: title },
      });
    }

    const { id, created } = await this.deps.record({
      workspaceId: req.workspaceId,
      topic,
      title,
      rationale,
      dedupeKey: key,
      decidedByMemberId: req.decidedByMemberId,
      memoryId,
      taskId: req.taskId ?? null,
      approvalRequestId,
    });

    if (req.taskId && this.deps.linkTaskMemory) {
      await this.deps.linkTaskMemory({
        workspaceId: req.workspaceId,
        taskId: req.taskId,
        memoryId,
        createdByMemberId: req.decidedByMemberId,
      });
    }

    return {
      id,
      topic,
      title,
      rationale,
      status: "recorded",
      memoryId,
      taskId: req.taskId ?? null,
      approvalRequestId,
      pendingApproval: approvalRequestId !== null,
      created,
    };
  }

  /**
   * Supersede an existing decision with a newer call (the prior one is kept, marked stale — version
   * history). Same sanitize + mirror + gate path as {@link record}. `superseded:false` ⇒ the new decision
   * dedup'd into the old one (no-op).
   */
  async supersede(
    oldId: string,
    req: RecordDecisionRequest,
  ): Promise<RecordedDecision & { supersededId: string | null }> {
    const topic = normalizeTopic(req.topic);
    const title = sanitizeDecisionText(req.title);
    const rationale = sanitizeDecisionText(req.rationale, 600);
    const key = decisionDedupeKey(topic, title);

    const memoryId = await this.deps.mirrorToMemory({
      workspaceId: req.workspaceId,
      topic,
      title,
      rationale,
      dedupeKey: key,
      sourceId: req.taskId ?? null,
      createdByMemberId: req.decidedByMemberId,
    });

    let approvalRequestId: string | null = null;
    if (req.external) {
      approvalRequestId = await this.deps.parkApproval({
        workspaceId: req.workspaceId,
        requesterMemberId: req.decidedByMemberId,
        actionType: req.external.actionType,
        amount: req.external.amount,
        summary: sanitizeDecisionText(req.external.summary, 280),
        payload: { ...(req.external.payload ?? {}), decisionTopic: topic, decisionTitle: title },
      });
    }

    const { newId, created, superseded } = await this.deps.supersede({
      oldId,
      workspaceId: req.workspaceId,
      topic,
      title,
      rationale,
      dedupeKey: key,
      decidedByMemberId: req.decidedByMemberId,
      memoryId,
      taskId: req.taskId ?? null,
      approvalRequestId,
    });

    return {
      id: newId,
      topic,
      title,
      rationale,
      status: "recorded",
      memoryId,
      taskId: req.taskId ?? null,
      approvalRequestId,
      pendingApproval: approvalRequestId !== null,
      created,
      supersededId: superseded ? oldId : null,
    };
  }

  /**
   * Recall the prior decisions an agent should reuse before deciding. With `topic`, the precise prior
   * calls on that subject; without it, the workspace's most recent decisions as general context. Returns
   * the clean rows plus a chatter-free brief ready to drop into a prompt.
   */
  async recall(
    workspaceId: string,
    query: { topic?: string; limit?: number } = {},
  ): Promise<DecisionRecall> {
    const rows = await this.deps.recallDecisions(workspaceId, {
      topic: query.topic ? normalizeTopic(query.topic) : undefined,
      limit: query.limit,
    });
    const decisions = rows.map(toRecalled);
    return { decisions, brief: formatDecisionBrief(decisions) };
  }

  /** A decision by id, scoped to the workspace (undefined if absent or cross-workspace). */
  async get(workspaceId: string, id: string): Promise<AgentDecisionRow | undefined> {
    return this.deps.getDecision(workspaceId, id);
  }

  /** Browse decisions (newest first); superseded excluded unless `includeSuperseded`. */
  async list(
    workspaceId: string,
    filter: { topic?: string; includeSuperseded?: boolean; limit?: number } = {},
  ): Promise<AgentDecisionRow[]> {
    return this.deps.listDecisions(workspaceId, {
      topic: filter.topic ? normalizeTopic(filter.topic) : undefined,
      includeSuperseded: filter.includeSuperseded,
      limit: filter.limit,
    });
  }

  /** The DATA-framed "prior decisions" preamble block for a launched agent (null when nothing to reuse). */
  async priorDecisionsBlock(
    workspaceId: string,
    query: { topic?: string; limit?: number } = {},
  ): Promise<string | null> {
    const { decisions } = await this.recall(workspaceId, query);
    return composePriorDecisionsBlock(decisions);
  }
}
