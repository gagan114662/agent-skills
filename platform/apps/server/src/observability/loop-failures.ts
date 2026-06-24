import type { FailureClass, FailureEvent } from "../flywheel/types.js";

export type LoopName = "autonomy" | "watchdog" | "sre";
export type LoopFailureRecorder = (event: FailureEvent) => Promise<unknown>;

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  if (typeof err === "string" && err.trim() !== "") return err;
  return "unknown error";
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function loopFailureClass(loop: LoopName): FailureClass {
  return loop === "watchdog" ? "watchdog_revival" : "ops_incident";
}

export function loopFailureEvent(input: {
  loop: LoopName;
  workspaceId: string;
  err: unknown;
}): FailureEvent {
  return {
    workspaceId: input.workspaceId,
    failureClass: loopFailureClass(input.loop),
    message: `${input.loop} workspace tick failed: ${errorMessage(input.err)}`,
    source: `loop:${input.loop}`,
    detail: errorDetail(input.err),
  };
}

export async function recordLoopWorkspaceFailure(input: {
  recorder?: LoopFailureRecorder;
  loop: LoopName;
  workspaceId: string;
  err: unknown;
}): Promise<void> {
  if (!input.recorder) return;
  try {
    await input.recorder(loopFailureEvent(input));
  } catch {
    // Loop failure fingerprinting must never hide the original loop error/log line.
  }
}
