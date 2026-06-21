/**
 * Production wiring for the execution-tool framework (#464). Binds the pure service to the real seams:
 *
 *   - `approvals.park` — creates a PENDING #13 `approval_requests` row via the same `createRequest` repo
 *     every other gated path uses. That row (plus its `requested` event) IS the durable audit-of-record the
 *     #147 audit feed already reads — nothing executes until the owner approves it there.
 *   - `audit` — an additional structured log line per invocation (including every refusal), so a blocked or
 *     parked attempt is observable in the logs even before it reaches the decision queue.
 *   - `flags` — the per-workspace permission switch. Execution tools are safe to leave ON (the framework can
 *     only PARK an approval, never fire), so they default enabled; a deployment can force them off with
 *     `RELOAD_AGENT_TOOLS_ENABLED=false` without touching the gate.
 *
 * There is deliberately NO executor wired here: actuation lives in the per-department services
 * (`social`/`hosted`/`outreach`), behind the owner's yes. This module only classifies, parks, and audits.
 */
import type { FastifyBaseLogger } from "fastify";
import { createRequest } from "../db/repositories/approvals.js";
import { EXECUTION_TOOLS } from "./registry.js";
import {
  ExecutionToolService,
  type ExecutionApprovalGate,
  type ExecutionAuditEntry,
  type ExecutionAuditSink,
} from "./service.js";

/** True unless a deployment explicitly forces execution tools off. The gate — not this flag — is the guard. */
function executionToolsEnabled(): boolean {
  return process.env.RELOAD_AGENT_TOOLS_ENABLED !== "false";
}

/** The #13 gate, production-wired: park a PENDING request the owner approves in the decision queue. */
function createApprovalGate(): ExecutionApprovalGate {
  return {
    park: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: input.actionType,
        payload: input.payload,
        amount: input.amount,
        summary: input.summary,
        status: "pending", // ALWAYS pending — an execution tool never auto-approves (#464).
        expiresAt: null,
        events: [
          {
            type: "requested",
            detail: { source: "agent-tools", actionType: input.actionType },
          },
        ],
      });
      return { id: req.id };
    },
  };
}

/** A logger-backed audit sink — every invocation (parked or refused) emits one structured line. */
function createAuditSink(log: FastifyBaseLogger): ExecutionAuditSink {
  return {
    record: (entry: ExecutionAuditEntry) => {
      log.info(
        {
          event: "agent_tool_invocation",
          workspaceId: entry.workspaceId,
          requesterMemberId: entry.requesterMemberId,
          tool: entry.toolName,
          gatedAction: entry.gatedAction,
          visibility: entry.visibility,
          outcome: entry.outcome,
          approvalRequestId: entry.approvalRequestId,
        },
        "agent execution-tool invocation",
      );
    },
  };
}

/** Build the production-wired execution-tool service over the real #13 queue + the request logger. */
export function createDefaultExecutionToolService(log: FastifyBaseLogger): ExecutionToolService {
  return new ExecutionToolService({
    registry: EXECUTION_TOOLS,
    flags: () => ({ enabled: executionToolsEnabled() }),
    approvals: createApprovalGate(),
    audit: createAuditSink(log),
  });
}
