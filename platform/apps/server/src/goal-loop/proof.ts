export interface GoalLoopProofGap {
  requirement:
    | "durable_goal"
    | "automated_verification"
    | "persistent_state"
    | "bounded_loop"
    | "senior_tools"
    | "next_move";
  message: string;
}

export interface GoalLoopProofResult {
  proven: boolean;
  gaps: GoalLoopProofGap[];
}

export interface GoalLoopProof {
  goal: {
    id: string;
    statement: string;
    owner: "system" | "workspace" | "agent";
    createdAt: string;
  };
  automation: {
    cadence: "scheduled" | "event_driven" | "manual";
    triggerReceipt: string;
    repeatCount: number;
  };
  verification: {
    automated: boolean;
    command: string;
    lastRunAt: string;
    lastResult: "pass" | "fail";
    receipt: string;
  };
  state: {
    persisted: boolean;
    store: "database" | "state_file" | "linear" | "github_issue";
    stateRef: string;
    survivesRestart: boolean;
  };
  budget: {
    maxTurns: number;
    maxTokens: number;
    retryPolicy: "stop" | "retry_with_backoff" | "retry_until_pass";
  };
  seniorTools: {
    rootCauseLogged: boolean;
    blockersNamed: boolean;
    escalationPath: string;
  };
  nextMove: {
    decision: "continue" | "stop" | "retry" | "escalate" | "complete";
    reason: string;
    nextGoalId: string | null;
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function push(
  gaps: GoalLoopProofGap[],
  requirement: GoalLoopProofGap["requirement"],
  message: string,
): void {
  gaps.push({ requirement, message });
}

function positiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRealReceipt(value: string): boolean {
  return /^(https:\/\/|gh:|run:|db:|state:|linear:|issue:|artifact:)/.test(value);
}

export function verifyGoalLoopProof(proof: GoalLoopProof): GoalLoopProofResult {
  const gaps: GoalLoopProofGap[] = [];

  if (!text(proof.goal?.id) || text(proof.goal?.statement).length < 20) {
    push(gaps, "durable_goal", "Goal proof must include a durable id and a specific objective.");
  }
  if (proof.goal?.owner !== "system" && proof.goal?.owner !== "workspace" && proof.goal?.owner !== "agent") {
    push(gaps, "durable_goal", "Goal owner must be system, workspace, or agent.");
  }

  if (proof.automation?.cadence === "manual") {
    push(gaps, "automated_verification", "Manual prompting cannot prove an agentic loop.");
  }
  if (!positiveInt(proof.automation?.repeatCount) || proof.automation.repeatCount < 2) {
    push(gaps, "automated_verification", "Loop proof must show at least two automated turns.");
  }
  if (!isRealReceipt(text(proof.automation?.triggerReceipt))) {
    push(gaps, "automated_verification", "Automation trigger must carry a real run, issue, artifact, or URL receipt.");
  }

  if (!proof.verification?.automated || text(proof.verification.command) === "") {
    push(gaps, "automated_verification", "Verification must be automated with an executable command.");
  }
  if (proof.verification?.lastResult !== "pass") {
    push(gaps, "automated_verification", "Latest verifier result must pass before the loop can close.");
  }
  if (!isRealReceipt(text(proof.verification?.receipt))) {
    push(gaps, "automated_verification", "Verifier receipt must be a real run, artifact, issue, database, or URL reference.");
  }

  if (!proof.state?.persisted || !proof.state.survivesRestart) {
    push(gaps, "persistent_state", "State must persist outside the agent turn and survive restart.");
  }
  if (!["database", "state_file", "linear", "github_issue"].includes(proof.state?.store)) {
    push(gaps, "persistent_state", "State store must be database, state_file, linear, or github_issue.");
  }
  if (!isRealReceipt(text(proof.state?.stateRef))) {
    push(gaps, "persistent_state", "State reference must be a real durable pointer.");
  }

  if (!positiveInt(proof.budget?.maxTurns) || !positiveInt(proof.budget?.maxTokens)) {
    push(gaps, "bounded_loop", "Loop must declare positive turn and token budgets.");
  }
  if (proof.budget?.retryPolicy === "retry_until_pass") {
    push(gaps, "bounded_loop", "Retry-until-pass is unbounded; use stop or retry_with_backoff.");
  }

  if (!proof.seniorTools?.rootCauseLogged || !proof.seniorTools.blockersNamed) {
    push(gaps, "senior_tools", "Loop must log root cause and name blockers before continuing.");
  }
  if (text(proof.seniorTools?.escalationPath).length < 10) {
    push(gaps, "senior_tools", "Loop must define where blocked work escalates.");
  }

  if (!["continue", "stop", "retry", "escalate", "complete"].includes(proof.nextMove?.decision)) {
    push(gaps, "next_move", "Loop must record an explicit next-move decision.");
  }
  if (text(proof.nextMove?.reason).length < 10) {
    push(gaps, "next_move", "Next-move decision must include a reason.");
  }
  if (proof.nextMove?.decision === "continue" && !text(proof.nextMove.nextGoalId)) {
    push(gaps, "next_move", "Continue decisions must point at the next durable goal id.");
  }

  return { proven: gaps.length === 0, gaps };
}
