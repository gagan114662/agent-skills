/**
 * A2A (Agent2Agent) wire types — issue #12. Hand-written TypeScript mirrors of the published A2A
 * specification's JSON Schema (v0.3.x). Only the objects this adapter emits/accepts are modelled;
 * streaming, push-notification and file/data transfer types are out of scope (the AgentCard
 * advertises them as unsupported). Source: https://github.com/a2aproject/A2A (specification/json).
 */

/** A2A task lifecycle states (`TaskState` in the spec). */
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

export interface A2ATextPart {
  kind: "text";
  text: string;
}
export interface A2ADataPart {
  kind: "data";
  data: Record<string, unknown>;
}
export interface A2AFilePart {
  kind: "file";
  file: { name?: string; mimeType?: string; uri?: string };
}
export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

export interface A2AMessage {
  kind: "message";
  role: "user" | "agent";
  parts: A2APart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  /** ISO-8601 timestamp. */
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
}

export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2ASecurityScheme {
  type: string;
  scheme?: string;
  description?: string;
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport?: string;
  version: string;
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  securitySchemes?: Record<string, A2ASecurityScheme>;
  security?: Array<Record<string, string[]>>;
}

// ---- JSON-RPC 2.0 envelope (the A2A transport) ------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

/** Standard JSON-RPC error codes we use (plus A2A's task-not-found range). */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** A2A: TaskNotFoundError. */
  TASK_NOT_FOUND: -32001,
} as const;
