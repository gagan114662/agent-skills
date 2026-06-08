/**
 * ACP (Agent Communication Protocol) wire types — issue #12. Hand-written TypeScript mirrors of the
 * published ACP schema (agentcommunicationprotocol.dev, 2025 draft). ACP is run-centric REST: a
 * client lists agent manifests, then creates/reads *runs* whose input/output are `Message`s. Only
 * the objects this adapter emits/accepts are modelled.
 */

/** An ACP message part. `content_type` defaults to `text/plain`; we emit text parts. */
export interface AcpMessagePart {
  name?: string | null;
  content_type: string;
  content?: string | null;
  content_encoding?: "plain" | "base64";
  content_url?: string | null;
}

export interface AcpMessage {
  role: string; // "user" | "agent" (ACP also allows "agent/{name}")
  parts: AcpMessagePart[];
}

/** ACP run lifecycle status. */
export type AcpRunStatus =
  | "created"
  | "in-progress"
  | "awaiting"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export interface AcpRun {
  run_id: string;
  agent_name: string;
  session_id?: string | null;
  status: AcpRunStatus;
  output: AcpMessage[];
  created_at?: string;
  finished_at?: string | null;
}

/** An ACP agent manifest (discovery). */
export interface AcpAgent {
  name: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}
