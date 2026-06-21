import { DeterministicExtractor } from "../memory/extract.js";
import type { DecisionService } from "./service.js";

/**
 * Auto-capture (issue #513): turn a department agent's posted deliverable into recorded decisions, so a
 * teammate can reuse them without being re-told. Reuses the #15 deterministic extractor (network-free) to
 * pick out the decision-type statements, then records each through the {@link DecisionService} (sanitized,
 * deduped, mirrored to the browsable graph). An internal memory write only — never an external action.
 */

/** Pure: the decision-type statements in a blob of agent output, capped (first-stated first). */
export async function extractDecisionStatements(text: string, cap = 3): Promise<string[]> {
  const extraction = await new DeterministicExtractor().extract({ text });
  return extraction.memories
    .filter((m) => m.type === "decision")
    .map((m) => m.text)
    .slice(0, Math.max(0, cap));
}

export interface CaptureDeliverableInput {
  workspaceId: string;
  agentMemberId: string;
  /** the objective the agent worked — used as the decision topic + rationale context. */
  task: string;
  /** the full posted deliverable text to scan for decisions. */
  deliverable: string;
}

/**
 * Capture the decisions in a deliverable into the shared store. Returns how many were recorded (0 when the
 * deliverable stated no decision). Idempotent via the service's dedup, so re-posting the same work does not
 * duplicate. Best-effort by design: the caller wraps this so a capture error never blocks the agent.
 */
export async function captureDecisionsFromDeliverable(
  service: DecisionService,
  input: CaptureDeliverableInput,
): Promise<number> {
  const statements = await extractDecisionStatements(input.deliverable);
  let recorded = 0;
  for (const title of statements) {
    await service.record({
      workspaceId: input.workspaceId,
      decidedByMemberId: input.agentMemberId,
      topic: input.task,
      title,
      rationale: `Recorded from a completed deliverable while working on: ${input.task}`,
    });
    recorded++;
  }
  return recorded;
}
