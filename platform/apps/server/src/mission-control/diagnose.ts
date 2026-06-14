import { classifyFailure, failureCopy, isSuccess, type FailureReasonClass } from "../runtime/outcome.js";
import type { SessionStatus } from "../runtime/types.js";

/**
 * The "why is nothing running?" diagnostic (#230). The console used to sit on "clocking in… hang tight"
 * forever whenever activation produced no live session — the failure was swallowed. This is the pure,
 * tested core that turns the workspace's recent sessions + activation state into ONE honest, actionable
 * state, so the owner always sees either a filling board or an explicit reason, never an infinite wait.
 *
 * Pure: no IO, no wall-clock (the caller injects `nowMs`), so every branch is unit-tested in isolation.
 */

export type DiagnosticState =
  /** Live sessions are working — the board is filling. The happy path. */
  | "running"
  /** Nothing live, and recent sessions are dying (spawn/auth/…); the dominant class explains why. */
  | "sessions_failing"
  /** Not activated yet — no founding venture in flight. */
  | "no_venture"
  /** Funded venture but no epic/tasks to pick up yet (kickoff hasn't produced work). */
  | "no_work"
  /** Activated with work to do, nothing running right now and nothing failing — just idle. */
  | "idle";

/** A recent session as the diagnostic reads it (status + exit so it can classify a failure). */
export interface RecentSessionInput {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: SessionStatus;
  exitCode: number | null;
  /** Already-redacted terminal tail — used ONLY to refine the failure class, never rendered raw. */
  result: string | null;
  endedAtMs: number | null;
  createdAtMs: number;
}

/** A failed session surfaced to the console with its classified reason (no raw output tail). */
export interface RecentFailureView {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: SessionStatus;
  exitCode: number | null;
  failureClass: FailureReasonClass;
  headline: string;
  detail: string;
  endedAtMs: number | null;
}

export interface MissionDiagnostic {
  state: DiagnosticState;
  /** Brand-voice headline the console shows in place of "hang tight". */
  headline: string;
  /** One line on what to do next. */
  detail: string;
  /** The failure class behind a `sessions_failing` state (else null). */
  dominantFailureClass: FailureReasonClass | null;
  liveCount: number;
  /** How many recent sessions failed (within the recency window for the `sessions_failing` decision). */
  recentFailureCount: number;
}

/** Only failures this recent count toward "currently failing" (older ones are history, not the live story). */
export const RECENT_FAILURE_WINDOW_MS = 15 * 60_000;

function isTerminal(status: SessionStatus): boolean {
  return status !== "provisioning" && status !== "running";
}

/** The most frequent failure class (ties broken by first-seen order). */
function dominant(classes: FailureReasonClass[]): FailureReasonClass {
  const counts = new Map<FailureReasonClass, number>();
  for (const c of classes) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = classes[0]!;
  let bestN = 0;
  for (const c of classes) {
    const n = counts.get(c)!;
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  return best;
}

export interface DiagnoseInput {
  /** How many live (provisioning/running) sessions the workspace has right now. */
  liveCount: number;
  /** The workspace's recent sessions (incl. terminal), newest first. */
  recent: RecentSessionInput[];
  /** Whether the workspace has a founding venture (activated). */
  hasVenture: boolean;
  /** Whether that venture has an epic / open tasks for the team to pick up. */
  hasOpenWork: boolean;
  nowMs: number;
}

export function diagnose(input: DiagnoseInput): {
  diagnostic: MissionDiagnostic;
  recentFailures: RecentFailureView[];
} {
  const { liveCount, recent, hasVenture, hasOpenWork, nowMs } = input;

  const failures: RecentFailureView[] = recent
    .filter((s) => isTerminal(s.status) && !isSuccess(s.status))
    .map((s) => {
      const failureClass = classifyFailure({
        status: s.status,
        exitCode: s.exitCode,
        outputTail: s.result ?? undefined,
      });
      const copy = failureCopy(failureClass);
      return {
        id: s.id,
        channelId: s.channelId,
        agentMemberId: s.agentMemberId,
        status: s.status,
        exitCode: s.exitCode,
        failureClass,
        headline: copy.headline,
        detail: copy.detail,
        endedAtMs: s.endedAtMs,
      };
    });

  // 1. Something is live → the board is filling. The happy path; failures are just history.
  if (liveCount > 0) {
    return {
      diagnostic: {
        state: "running",
        headline: "Your team is on the board.",
        detail: `${liveCount} session${liveCount === 1 ? " is" : "s are"} working right now.`,
        dominantFailureClass: null,
        liveCount,
        recentFailureCount: 0,
      },
      recentFailures: failures,
    };
  }

  // 2. Nothing live, but sessions have died recently → surface WHY (the anti-"hang tight" branch).
  const recentlyFailed = failures.filter(
    (f) => f.endedAtMs === null || nowMs - f.endedAtMs <= RECENT_FAILURE_WINDOW_MS,
  );
  if (recentlyFailed.length > 0) {
    const cls = dominant(recentlyFailed.map((f) => f.failureClass));
    const copy = failureCopy(cls);
    return {
      diagnostic: {
        state: "sessions_failing",
        headline: copy.headline,
        detail: copy.detail,
        dominantFailureClass: cls,
        liveCount: 0,
        recentFailureCount: recentlyFailed.length,
      },
      recentFailures: failures,
    };
  }

  // 3. Nothing live, nothing failing — explain the activation state instead of waiting forever.
  if (!hasVenture) {
    return {
      diagnostic: {
        state: "no_venture",
        headline: "No venture in flight yet.",
        detail: "Activate to stand up your founding venture and put the team to work.",
        dominantFailureClass: null,
        liveCount: 0,
        recentFailureCount: 0,
      },
      recentFailures: failures,
    };
  }
  if (!hasOpenWork) {
    return {
      diagnostic: {
        state: "no_work",
        headline: "Your venture is funded — lining up the first tasks.",
        detail: "If this doesn't clear shortly, re-activate or @mention a lead to kick off the work.",
        dominantFailureClass: null,
        liveCount: 0,
        recentFailureCount: 0,
      },
      recentFailures: failures,
    };
  }
  return {
    diagnostic: {
      state: "idle",
      headline: "The team is between tasks.",
      detail: "@mention a lead to kick off the next piece of work.",
      dominantFailureClass: null,
      liveCount: 0,
      recentFailureCount: 0,
    },
    recentFailures: failures,
  };
}
