/**
 * The execution-tool service (#464) — the single agent-facing seam that turns an agent's request to "act
 * outside" into a parked, audited human-approval. It is where the framework's one invariant is enforced:
 *
 *   invoke() NEVER executes. It validates, classifies the boundary, parks a PENDING #13 approval, and writes
 *   an audit entry. The real-world action runs later — only after a human approves — through the existing
 *   per-department executor. There is no autonomous-fire path here, by construction.
 *
 * Every step is fail-closed: an unknown tool, invalid args, or a tool wired to an action outside the #13
 * gating taxonomy all refuse WITHOUT parking, and each refusal is itself audited (so a blocked attempt is
 * never invisible). The parking payload carries routing ids only (never free-form content) and the summary
 * is built structurally by the tool's pure `prepare` (injection defense, #200 §6).
 */
import { classifyExecutionBoundary, isGatedAction } from "./decide.js";
import { executionToolsForDepartment, findExecutionTool } from "./registry.js";
import type { ExecutionToolSpec, ToolVisibility } from "./types.js";

/** Whether a workspace may invoke execution tools at all (the per-workspace permission switch). */
export interface ExecutionToolFlags {
  enabled: boolean;
}

/**
 * The #13 gate seam — submit (park) only. Like the social/hosted gates there is NO auto-approve branch:
 * the framework ALWAYS parks a PENDING request, because every execution boundary is the owner's call.
 */
export interface ExecutionApprovalGate {
  park(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionType: string;
    summary: string;
    payload: Record<string, unknown>;
    amount: number | null;
  }): Promise<{ id: string }>;
}

/** One immutable audit entry for an execution-tool invocation — every attempt, gated or refused. */
export interface ExecutionAuditEntry {
  workspaceId: string;
  requesterMemberId: string;
  toolName: string;
  gatedAction: string | null;
  visibility: ToolVisibility | null;
  outcome: "pending_approval" | "rejected" | "unknown_tool" | "disabled";
  approvalRequestId: string | null;
  reason: string;
  summary: string | null;
  at: Date;
}

/** The append-only sink the service writes every invocation to (the framework's own audit trail). */
export interface ExecutionAuditSink {
  record(entry: ExecutionAuditEntry): Promise<void> | void;
}

export interface ExecutionToolServiceDeps {
  registry: readonly ExecutionToolSpec[];
  flags: (workspaceId: string) => ExecutionToolFlags;
  approvals: ExecutionApprovalGate;
  audit: ExecutionAuditSink;
  /** Injected clock so audit timestamps are deterministic in tests. */
  now?: () => Date;
}

export interface InvokeInput {
  workspaceId: string;
  requesterMemberId: string;
  toolName: string;
  args: unknown;
}

export type InvokeResult =
  | { status: "disabled" }
  | { status: "unknown_tool"; toolName: string }
  | { status: "rejected"; reason: string }
  | {
      status: "pending_approval";
      approvalRequestId: string;
      gatedAction: string;
      visibility: ToolVisibility;
      boundary: ToolVisibility;
      summary: string;
    };

export class ExecutionToolService {
  private readonly now: () => Date;

  constructor(private readonly deps: ExecutionToolServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The execution tools an agent department carries (or the whole catalog) — for runtime advertisement. */
  listTools(department?: string): ExecutionToolSpec[] {
    if (department) return executionToolsForDepartment(department).filter((t) => this.has(t.name));
    return this.deps.registry.filter((t) => this.has(t.name)).map((t) => t);
  }

  private has(name: string): boolean {
    return this.deps.registry.some((t) => t.name === name);
  }

  /**
   * Invoke an execution tool: validate → classify the human-approval boundary → park a PENDING #13 approval →
   * audit. Never executes. Fail-closed at every step, and every outcome (including a refusal) is audited.
   */
  async invoke(input: InvokeInput): Promise<InvokeResult> {
    if (!this.deps.flags(input.workspaceId).enabled) {
      await this.write(input, {
        outcome: "disabled",
        gatedAction: null,
        visibility: null,
        approvalRequestId: null,
        summary: null,
        reason: "execution tools are not enabled for this workspace",
      });
      return { status: "disabled" };
    }

    const tool = findExecutionTool(input.toolName);
    if (!tool || !this.has(tool.name)) {
      await this.write(input, {
        outcome: "unknown_tool",
        gatedAction: null,
        visibility: null,
        approvalRequestId: null,
        summary: null,
        reason: `no such execution tool: ${input.toolName}`,
      });
      return { status: "unknown_tool", toolName: input.toolName };
    }

    // Permission: a tool can only ever park an action the #13 taxonomy already gates (no orphan authority).
    if (!isGatedAction(tool.gatedAction)) {
      const reason = `tool ${tool.name} is not wired to a gated action`;
      await this.write(input, {
        outcome: "rejected",
        gatedAction: tool.gatedAction,
        visibility: tool.visibility,
        approvalRequestId: null,
        summary: null,
        reason,
      });
      return { status: "rejected", reason };
    }

    const prep = tool.prepare(input.args);
    if (!prep.ok) {
      await this.write(input, {
        outcome: "rejected",
        gatedAction: tool.gatedAction,
        visibility: tool.visibility,
        approvalRequestId: null,
        summary: null,
        reason: prep.error,
      });
      return { status: "rejected", reason: prep.error };
    }

    const boundary = classifyExecutionBoundary(tool, prep.amount);
    // ALWAYS parks — there is no autonomous-fire branch (the framework's core invariant).
    const req = await this.deps.approvals.park({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: tool.gatedAction,
      summary: prep.summary.slice(0, 140),
      payload: prep.payload,
      amount: prep.amount,
    });

    await this.write(input, {
      outcome: "pending_approval",
      gatedAction: tool.gatedAction,
      visibility: tool.visibility,
      approvalRequestId: req.id,
      summary: prep.summary,
      reason: boundary.reason,
    });

    return {
      status: "pending_approval",
      approvalRequestId: req.id,
      gatedAction: tool.gatedAction,
      visibility: tool.visibility,
      boundary: boundary.boundary,
      summary: prep.summary,
    };
  }

  private async write(
    input: InvokeInput,
    rest: Omit<ExecutionAuditEntry, "workspaceId" | "requesterMemberId" | "toolName" | "at">,
  ): Promise<void> {
    await this.deps.audit.record({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      toolName: input.toolName,
      at: this.now(),
      ...rest,
    });
  }
}
