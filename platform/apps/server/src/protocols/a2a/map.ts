/**
 * Pure mappers between Reload's internal model and the A2A wire format (issue #12). No DB, no
 * Fastify, no I/O — every function is deterministic given its inputs, so the mapping is unit-tested
 * in isolation and the route layer stays thin. Ids/timestamps are passed in by the caller (the
 * route) so these functions never reach for a clock or a uuid generator.
 */

import type { TaskStatus } from "../../tasks/status.js";
import type {
  A2AAgentCard,
  A2AMessage,
  A2APart,
  A2ATask,
  A2ATaskState,
  A2ATextPart,
} from "./types.js";

/** The A2A spec version this adapter targets (advertised in the AgentCard). */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/** Internal task status → A2A task state. */
export const A2A_STATE_BY_STATUS: Record<TaskStatus, A2ATaskState> = {
  backlog: "submitted",
  todo: "submitted",
  in_progress: "working",
  blocked: "input-required",
  done: "completed",
  canceled: "canceled",
};

export function a2aStateFromStatus(status: TaskStatus): A2ATaskState {
  return A2A_STATE_BY_STATUS[status];
}

export function textPart(text: string): A2ATextPart {
  return { kind: "text", text };
}

/** Flatten any message parts to a single text blob (the preserved handoff context). */
export function partsToText(parts: A2APart[]): string {
  return parts
    .map((p) => {
      if (p.kind === "text") return p.text;
      if (p.kind === "data") return JSON.stringify(p.data);
      return p.file?.uri ?? p.file?.name ?? "[file]";
    })
    .join("\n");
}

/** Build a well-formed A2A `Message`. */
export function a2aMessage(input: {
  messageId: string;
  role: "user" | "agent";
  text: string;
  taskId?: string;
  contextId?: string;
}): A2AMessage {
  const msg: A2AMessage = {
    kind: "message",
    role: input.role,
    parts: [textPart(input.text)],
    messageId: input.messageId,
  };
  if (input.taskId) msg.taskId = input.taskId;
  if (input.contextId) msg.contextId = input.contextId;
  return msg;
}

/**
 * Map an internal task to an A2A `Task`. `contextId` defaults to the task id (A2A requires a
 * contextId; a Reload task is its own context). `history` carries the preserved handoff
 * conversation so a receiving agent that calls `tasks/get` sees the original content intact.
 */
export function toA2ATask(input: {
  id: string;
  status: TaskStatus;
  contextId?: string;
  history?: A2AMessage[];
  timestamp?: string;
}): A2ATask {
  const task: A2ATask = {
    kind: "task",
    id: input.id,
    contextId: input.contextId ?? input.id,
    status: { state: a2aStateFromStatus(input.status) },
    artifacts: [],
  };
  if (input.timestamp) task.status.timestamp = input.timestamp;
  if (input.history) task.history = input.history;
  return task;
}

/**
 * Derive an A2A `AgentCard` from a registry agent (#3) + platform context. This *is* the capability
 * handshake: it tells a caller how to authenticate (`bearerAuth`) and what the agent accepts. The
 * `framework` (when set) becomes a skill tag so a peer can route by it. Pure + deterministic.
 */
export function buildAgentCard(
  agent: { name: string; framework: string | null },
  opts: { baseUrl: string; agentId: string },
): A2AAgentCard {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/a2a/agents/${opts.agentId}`;
  const fwTags = agent.framework ? [agent.framework] : [];
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.name,
    description: `Reload agent "${agent.name}" — reachable over A2A (JSON-RPC) for task handoff.`,
    url,
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "handoff",
        name: "Task handoff",
        description:
          "Accept a delegated task with its context via `message/send`; track it with `tasks/get`.",
        tags: ["handoff", "task", ...fwTags],
        examples: ["Take over this investigation and report findings."],
      },
      {
        id: "messaging",
        name: "Workspace messaging",
        description: "Participate in the agent's Reload workspace channels and threads.",
        tags: ["messaging", ...fwTags],
      },
    ],
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    security: [{ bearerAuth: [] }],
  };
}
