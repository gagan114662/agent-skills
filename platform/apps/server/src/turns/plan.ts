/**
 * Pure plan-mode logic (issue #53, ADR-0030). No I/O — the plan state machine, the execution-task
 * composition (plan + feedback threaded as DATA, never argv — see #50), plan-block parsing, and
 * decision-input validation. Keeping this pure lets the controller/routes stay thin and locks the
 * plan invariants under fast, hermetic unit tests.
 */

/** A plan proposal's lifecycle. Terminal once decided. */
export type PlanStatus = "proposed" | "approved" | "approved_with_feedback" | "rejected";

/** The three decisions a human can make on a proposed plan. */
export type PlanDecision = "approve" | "approve_with_feedback" | "reject";

/** Thrown on an invalid transition / input; messages are content-free (safe to surface). */
export class PlanError extends Error {}

/** Delimiters a plan-mode harness wraps its proposed plan in (so the server can extract it). */
export const PLAN_MARKER_START = "<<<PLAN>>>";
export const PLAN_MARKER_END = "<<<END_PLAN>>>";

const FEEDBACK_MAX = 4000;
const DECISIONS: readonly PlanDecision[] = ["approve", "approve_with_feedback", "reject"];

/**
 * The plan state machine. Only a `proposed` plan may be decided; the decision maps to a terminal
 * status and tells the caller whether an execution turn should launch (`proceed`). Deciding an
 * already-decided plan throws — work blocks on exactly one decision.
 */
export function decidePlan(
  current: PlanStatus,
  decision: PlanDecision,
): { status: PlanStatus; proceed: boolean } {
  if (current !== "proposed") throw new PlanError("plan has already been decided");
  switch (decision) {
    case "approve":
      return { status: "approved", proceed: true };
    case "approve_with_feedback":
      return { status: "approved_with_feedback", proceed: true };
    case "reject":
      return { status: "rejected", proceed: false };
  }
}

/**
 * Validate a decision request from a client. `feedback` is required + non-empty for
 * `approve_with_feedback`, forbidden for the other two, and bounded. Returns the normalized
 * decision + feedback (trimmed, or null). Rejects with a clear, content-free error.
 */
export function validateDecisionInput(
  decision: string,
  feedback?: string,
): { decision: PlanDecision; feedback: string | null } {
  if (!DECISIONS.includes(decision as PlanDecision)) {
    throw new PlanError("decision must be approve, approve_with_feedback, or reject");
  }
  const d = decision as PlanDecision;
  const fb = feedback?.trim() ?? "";
  if (d === "approve_with_feedback") {
    if (!fb) throw new PlanError("feedback is required for approve_with_feedback");
  } else if (fb) {
    throw new PlanError("feedback is only allowed with approve_with_feedback");
  }
  if (fb.length > FEEDBACK_MAX) throw new PlanError("feedback is too long");
  return { decision: d, feedback: d === "approve_with_feedback" ? fb : null };
}

/**
 * Build the execution session's task from the original task + the approved plan, plus the reviewer
 * feedback note when approve-with-feedback. The whole string is passed to the harness via
 * `AGENT_TASK` (data, double-quoted env — see #50), so a hostile plan/feedback string cannot inject.
 * A rejected plan has no execution task — calling this for `reject` is a bug, so it throws.
 */
export function composeExecutionTask(
  originalTask: string,
  planText: string,
  decision: PlanDecision,
  feedback?: string | null,
): string {
  if (decision === "reject") throw new PlanError("a rejected plan has no execution task");
  const parts = [`Task: ${originalTask}`, "", "Approved plan:", planText.trim()];
  if (decision === "approve_with_feedback" && feedback && feedback.trim()) {
    parts.push("", "Reviewer feedback (incorporate this):", feedback.trim());
  }
  return parts.join("\n");
}

/**
 * Extract the proposed plan from a plan-mode harness's output: the trimmed block between
 * {@link PLAN_MARKER_START} and {@link PLAN_MARKER_END}. Returns null when there is no terminated,
 * non-empty block — so the propose route can reject a plan-mode run that produced no plan.
 */
export function parsePlanProposal(output: string): string | null {
  const start = output.indexOf(PLAN_MARKER_START);
  if (start < 0) return null;
  const after = start + PLAN_MARKER_START.length;
  const end = output.indexOf(PLAN_MARKER_END, after);
  if (end < 0) return null;
  const plan = output.slice(after, end).trim();
  return plan.length > 0 ? plan : null;
}
