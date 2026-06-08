/**
 * Pure mappers between Reload's internal model and the ACP wire format (issue #12). No DB, no
 * Fastify, no I/O. An ACP *run* is realized as a Reload thread (#6): the run's messages are channel
 * messages, the run's id is the thread-root message id, the run's output is the target agent's
 * in-thread replies. These functions translate shapes only; the route does the channel/thread I/O.
 */

import type { AcpAgent, AcpMessage, AcpMessagePart, AcpRun, AcpRunStatus } from "./types.js";

export function acpTextPart(content: string): AcpMessagePart {
  return { content_type: "text/plain", content };
}

export function acpMessage(role: "user" | "agent", text: string): AcpMessage {
  return { role, parts: [acpTextPart(text)] };
}

/** Flatten ACP message parts to text (we ingest text; non-text content is normalized). */
export function acpPartsToText(parts: AcpMessagePart[]): string {
  return parts
    .map((p) => p.content ?? p.content_url ?? "")
    .filter((s) => s.length > 0)
    .join("\n");
}

/** Map a registry agent (#3) to an ACP agent manifest. */
export function toAcpAgent(agent: {
  name: string;
  framework: string | null;
  deactivatedAt: Date | null;
}): AcpAgent {
  return {
    name: agent.name,
    description: `Reload agent "${agent.name}" — reachable over ACP runs.`,
    metadata: {
      kind: "agent",
      framework: agent.framework,
      status: agent.deactivatedAt ? "deactivated" : "active",
      provider: "reload",
    },
  };
}

/**
 * Derive a run's status from its thread: cancelled wins; otherwise a run with ≥1 reply from the
 * target agent is `completed`; a freshly-posted run with no agent reply yet is `created`.
 */
export function deriveRunStatus(opts: { hasAgentReply: boolean; cancelled?: boolean }): AcpRunStatus {
  if (opts.cancelled) return "cancelled";
  return opts.hasAgentReply ? "completed" : "created";
}

export function toAcpRun(input: {
  run_id: string;
  agent_name: string;
  session_id: string;
  status: AcpRunStatus;
  output: AcpMessage[];
}): AcpRun {
  return {
    run_id: input.run_id,
    agent_name: input.agent_name,
    session_id: input.session_id,
    status: input.status,
    output: input.output,
  };
}
