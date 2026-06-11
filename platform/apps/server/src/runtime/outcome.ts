import type { SessionStatus } from "./types.js";

/**
 * Session terminal-message rendering (#166).
 *
 * Before this, every finished session posted `✅ session ${status} (exit ${exitCode ?? "n/a"})` — a
 * GREEN CHECK even on failure ("✅ session failed (exit n/a)"). That is a lying checkmark: the owner
 * sees a tick and assumes the agent worked. This module is the pure, tested replacement: a check mark
 * ONLY for a clean completion, otherwise a failure mark + a short, on-brand (pop voice) explanation
 * carrying the failure's reason class so the owner knows what to do next.
 *
 * It is deliberately pure (no IO) and NEVER echoes the raw output tail — the tail is used only to
 * refine the reason class (auth markers), never rendered — so a secret that slipped into output can't
 * leak through the terminal message.
 */

/** The bucket a failed session falls into, surfaced inline so the message is actionable. */
export type FailureReasonClass = "spawn" | "auth" | "timeout" | "budget" | "canceled" | "error";

export interface SessionOutcome {
  status: SessionStatus;
  exitCode: number | null;
  /** Trailing (already-redacted) harness output. Used ONLY to refine the class — never rendered. */
  outputTail?: string;
}

/** True only for a cleanly-completed session. Everything else is a failure surface. */
export function isSuccess(status: SessionStatus): boolean {
  return status === "completed";
}

const AUTH_MARKERS = [
  "invalid api key",
  "authentication",
  "unauthorized",
  "please run claude",
  "/login",
  "oauth",
  "credit balance",
  "401",
];

const BUDGET_MARKERS = ["budget", "spending limit", "quota exceeded", "402"];

function matches(tail: string | undefined, markers: string[]): boolean {
  if (!tail) return false;
  const t = tail.toLowerCase();
  return markers.some((m) => t.includes(m));
}

/**
 * Classify why a session failed. Precedence matters:
 *  - timeout/idle reaps are explicit statuses → "timeout".
 *  - an explicit cancel ("canceled") also has a null exit code (the process was killed), so it MUST
 *    be checked before the spawn heuristic, otherwise a cancel would masquerade as a spawn failure.
 *  - a null exit code on a plain failure means the child never returned an exit code: it never even
 *    started (spawn ENOENT — a missing binary/shell, the exact #166 prod cause) or died before exit.
 *  - a non-zero exit whose output looks like an auth/budget problem is bucketed accordingly.
 *  - everything else is a generic harness "error".
 */
export function classifyFailure(o: SessionOutcome): FailureReasonClass {
  if (o.status === "timeout" || o.status === "idle_reaped") return "timeout";
  if (o.status === "canceled") return "canceled";
  if (o.exitCode === null) return "spawn";
  if (matches(o.outputTail, AUTH_MARKERS)) return "auth";
  if (matches(o.outputTail, BUDGET_MARKERS)) return "budget";
  return "error";
}

/** Brand-voice copy per reason class: one line on what happened, one on what to do next. */
const FAILURE_COPY: Record<FailureReasonClass, { headline: string; detail: string }> = {
  spawn: {
    headline: "I couldn't start up — my runtime is missing a tool I need",
    detail: "This one's on us, not you. The team's been pinged to patch the agent image — try again once it's redeployed.",
  },
  auth: {
    headline: "My Claude connection didn't go through",
    detail: "Ask the workspace owner to reconnect in **Settings → Connect Claude**, then @mention me again and I'll pick this right up.",
  },
  timeout: {
    headline: "I ran out of time on this one",
    detail: "Give me a tighter brief or split it into smaller asks and I'll get further.",
  },
  budget: {
    headline: "We've hit this workspace's budget ceiling",
    detail: "Top up or adjust the plan and I'll get back to work.",
  },
  canceled: {
    headline: "This run was stopped before I finished",
    detail: "@mention me again whenever you'd like me to take another pass.",
  },
  error: {
    headline: "I hit an error mid-run and had to stop",
    detail: "The details are in the thread above — nudge me to retry.",
  },
};

/**
 * Render the single terminal channel message for a finished session. Green check ONLY on completion;
 * any other status renders a failure mark, the brand-voice reason, and a small honest footer with the
 * raw status + exit code (what the old line exposed) for debugging — but never the output tail.
 */
export function renderSessionOutcome(o: SessionOutcome): string {
  if (isSuccess(o.status)) {
    return `✅ session completed (exit ${o.exitCode ?? 0})`;
  }
  const cls = classifyFailure(o);
  const copy = FAILURE_COPY[cls];
  return (
    `❌ ${copy.headline} _(${cls})_\n` +
    `${copy.detail}\n\n` +
    `\`session ${o.status} · exit ${o.exitCode ?? "n/a"}\``
  );
}
