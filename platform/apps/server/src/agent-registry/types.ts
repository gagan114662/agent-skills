/**
 * A2A call record shapes (#282, ADR-0282) — the observable receipt every agent-to-agent call produces,
 * whether it is allowed or denied. The record is the thing that makes the call path observable: each hop
 * is one record, and a chain of hops is the path. Pure data; no IO.
 */
import type { RiskTier } from "./contract.js";

/** The outcome class of an A2A call decision. */
export const A2A_CALL_STATUSES = ["allowed", "denied"] as const;
export type A2ACallStatus = (typeof A2A_CALL_STATUSES)[number];

/**
 * One observable hop in an A2A call path: caller → target for a declared capability. Deterministic and
 * timestamp-free (the persistence/audit layer stamps `at`) so it is reproducible in a unit test. A denied
 * hop is recorded too (with `reason`), so a refused call is never invisible.
 */
export interface A2ACallRecord {
  /** Stable id of this hop, derived deterministically from the chain (see `a2a.ts deriveCallId`). */
  callId: string;
  /** The agent that initiated the call (a fleet @handle). */
  callerHandle: string;
  /** The agent being called (a fleet @handle). */
  targetHandle: string;
  /** The capability requested on the target (one it advertises). */
  capability: string;
  /** The target's risk tier (so the path shows where the blast radius is). */
  riskTier: RiskTier;
  /** The sanitized task handed to the target as DATA (never instructions — injection defense). */
  task: string;
  /** Depth of this hop in the call chain (0 = the first call). The depth guard bounds runaway fan-out. */
  depth: number;
  /** The #13 action types the target's output can trigger downstream (observability, never authority). */
  downstreamGatedActions: string[];
  status: A2ACallStatus;
  /** Why the call was allowed or denied — always populated. */
  reason: string;
}

/** The decision an A2A call evaluation returns: the observable record plus a convenience `allowed` flag. */
export interface A2ACallDecision {
  allowed: boolean;
  record: A2ACallRecord;
}
