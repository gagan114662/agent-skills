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
export type FailureReasonClass = "spawn" | "auth" | "timeout" | "budget" | "canceled" | "model" | "error";

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

/**
 * Markers of a **model misconfiguration** (#242): the deployment (or a per-session #52 selection) pinned
 * a `--model` the API can't serve, so `claude -p` exits 1 having produced nothing — the exact prod cause
 * of "error · exit 1" after `claude-fable-5` (a non-existent model) was set deployment-wide. This is an
 * OWNER-actionable config error (like auth/budget), NOT a transient harness crash, so it gets its own
 * class + copy and routes to a self-healing incident instead of a doomed auto-fix agent. The phrases are
 * Claude Code's own model-error wording ("There's an issue with the selected model (X). It may not exist
 * or you may not have access to it.") plus the API's `model_not_found` shapes.
 */
const MODEL_MARKERS = [
  "selected model",
  "model_not_found",
  "model not found",
  "may not exist or you may not have access",
  "unknown model",
  "no endpoints found that support",
];

/**
 * Markers of a **self-reported startup failure** (#319). A `claude -p` run can BOOT, fail to find a tool
 * its runtime needs, then report that to the user as an ordinary assistant message and exit **0 with a
 * non-error `result` event** — so neither the exit code (0) nor {@link harnessEventReportsError}
 * (`is_error:false`) flags it, and the run would otherwise surface a green check + a "deliverable ready
 * for review" card whose entire content is "I couldn't start up — my runtime is missing a tool I need".
 * That is the exact `(spawn)` message the owner saw shipped on the board.
 *
 * The phrases here are the agent's OWN startup-failure wording (and our `spawn` failure copy below, which
 * the agent sometimes echoes). They are deliberately START-anchored at the call site (only the head of the
 * produced artifact is inspected) and specific to "start up" / "runtime is missing a tool" so a genuine
 * deliverable that merely *mentions* a missing tool is never misread as a boot failure.
 */
const STARTUP_FAILURE_MARKERS = [
  "could not start up",
  "couldn't start up",
  "couldnt start up",
  "cannot start up",
  "can't start up",
  "cant start up",
  "unable to start up",
  "failed to start up",
  "my runtime is missing a tool",
  "runtime is missing a tool",
];

function matches(tail: string | undefined, markers: string[]): boolean {
  if (!tail) return false;
  const t = tail.toLowerCase();
  return markers.some((m) => t.includes(m));
}

/**
 * Whether the produced text is the agent telling us it never really booted (#319). Inspected only over
 * the HEAD of the artifact — a real deliverable never *opens* by announcing it couldn't start up, and
 * the bounded window keeps an incidental later mention from tripping the detector.
 */
export function looksLikeStartupFailure(artifact: string | undefined): boolean {
  if (!artifact) return false;
  return matches(artifact.slice(0, 400), STARTUP_FAILURE_MARKERS);
}

/**
 * Classify why a session failed. Precedence matters:
 *  - timeout/idle reaps are explicit statuses → "timeout".
 *  - an explicit cancel ("canceled") also has a null exit code (the process was killed), so it MUST
 *    be checked before the spawn heuristic, otherwise a cancel would masquerade as a spawn failure.
 *  - a null exit code on a plain failure means the child never returned an exit code: it never even
 *    started (spawn ENOENT — a missing binary/shell, the exact #166 prod cause) or died before exit.
 *  - a non-zero exit whose output looks like an auth/budget problem is bucketed accordingly.
 *  - a non-zero exit whose output names a model the API can't serve is a "model" misconfig (#242) — an
 *    owner-actionable config error, surfaced before the generic bucket so "claude-fable-5" stops reading
 *    as an opaque "error · exit 1".
 *  - a run whose OUTPUT is the agent self-reporting that it couldn't start up (#319) is a "spawn"
 *    failure even on a clean (exit 0) process, so the message reads "couldn't start up — missing a tool"
 *    rather than a generic error. Checked before auth/budget/model so the boot failure wins its own copy.
 *  - everything else is a generic harness "error".
 */
export function classifyFailure(o: SessionOutcome): FailureReasonClass {
  if (o.status === "timeout" || o.status === "idle_reaped") return "timeout";
  if (o.status === "canceled") return "canceled";
  if (o.exitCode === null) return "spawn";
  if (looksLikeStartupFailure(o.outputTail)) return "spawn";
  if (matches(o.outputTail, AUTH_MARKERS)) return "auth";
  if (matches(o.outputTail, BUDGET_MARKERS)) return "budget";
  if (matches(o.outputTail, MODEL_MARKERS)) return "model";
  return "error";
}

/** The produced work-product + the terminal signals a session ends with — the disposition's full input. */
export interface SessionDispositionInput {
  /** The process's terminal status (`completed` on a clean exit). */
  status: SessionStatus;
  /** The process exit code (`null` when it never returned one — a true spawn failure). */
  exitCode: number | null;
  /**
   * Whether the harness stream ended in a terminal ERROR event (#251) — `{type:'result', is_error:true}`
   * for claude-code, a top-level `error`/`turn.failed` for codex. A process can exit 0 yet have failed.
   */
  harnessReportedError: boolean;
  /**
   * The agent's produced artifact — its structured final answer when the harness marked one, else the
   * redacted output tail (already bounded/redacted by the caller). The thing a deliverable card would show.
   */
  artifact: string;
}

/** The single, authoritative read of "did this session really finish real work, or did it fail?". */
export interface SessionDisposition {
  /**
   * The RECONCILED terminal status. `failed` whenever the run is not an output-bearing clean completion —
   * even when the process exited 0 (a harness error event, or a self-reported startup failure). Every
   * downstream consumer (terminal message, finalize, failure routing, deliverable surfacing) keys off this.
   */
  status: SessionStatus;
  /**
   * True ONLY for a clean completion that produced a REAL artifact (#200 production-grounded: assert the
   * agent actually booted and produced output before any done state). The single gate for surfacing a
   * deliverable / "shipped" board card — so a failed-to-start or no-output run can never show as done.
   */
  done: boolean;
  /** The failure bucket when not done (for routing + copy), else `null`. */
  failureClass: FailureReasonClass | null;
}

/**
 * Decide a session's honest disposition (#319) — the one place that maps a finished run to
 * done-vs-failed. It is the answer to the two board bugs:
 *   1. A failed/never-booted run must surface as **failed**, never done/shipped.
 *   2. A "done" state must be earned by real output, not merely a zero exit code.
 *
 * Precedence:
 *   - A non-clean terminal status (`failed`/`timeout`/`canceled`/…) is already a failure — classify + keep.
 *   - A clean exit whose stream ended in a harness error event (#251) is a no-artifact failure.
 *   - A clean exit whose OUTPUT is a self-reported startup failure (#319 — the `(spawn)` board bug) is a
 *     failure: the agent told us it never really booted, so we believe it over the zero exit code.
 *   - A clean exit with NO produced artifact is `completed` but **not done** — nothing to surface; this
 *     preserves the prior "no output ⇒ no deliverable, but not a hard failure" behavior exactly.
 *   - Otherwise: a real, output-bearing completion ⇒ done.
 *
 * Pure + total; the boolean and the reconciled status are unit-tested without a runtime.
 */
export function decideSessionDisposition(input: SessionDispositionInput): SessionDisposition {
  const refine = (status: SessionStatus): FailureReasonClass =>
    classifyFailure({ status, exitCode: input.exitCode, outputTail: input.artifact });

  if (!isSuccess(input.status)) {
    return { status: input.status, done: false, failureClass: refine(input.status) };
  }
  // Clean process exit, but a positive failure signal: the run failed and produced no real artifact.
  if (input.harnessReportedError || looksLikeStartupFailure(input.artifact)) {
    return { status: "failed", done: false, failureClass: refine("failed") };
  }
  // Clean completion. It is only DONE (surfaceable as a deliverable) if it actually produced something.
  return { status: "completed", done: input.artifact.trim().length > 0, failureClass: null };
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
  model: {
    headline: "The model this workspace is set to use isn't available",
    detail:
      "This one's on the setup, not you — the configured AI model can't be reached. Pick a valid model in " +
      "**Settings → Model** (or clear it to use the default), then @mention me again and I'll pick this right up.",
  },
  error: {
    headline: "I hit an error mid-run and had to stop",
    detail: "The details are in the thread above — nudge me to retry.",
  },
};

/** The brand-voice copy (headline + what-to-do-next) for a failure class — reused by the #230 diagnostic. */
export function failureCopy(cls: FailureReasonClass): { headline: string; detail: string } {
  return FAILURE_COPY[cls];
}

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

/** Upper bound on the agent's posted chat reply (#393), matching the deliverable card's draft cap. */
export const MAX_REPLY_CHARS = 4000;

/**
 * Strip C0/C1 control characters from a deliverable about to be posted as a chat message (#393), but
 * PRESERVE newlines and tabs — a real deliverable is multi-line, and unlike the agent→channel bridge's
 * `sanitizeData` (which collapses whitespace for a one-line status), this keeps the body's shape intact.
 * Pure: removes only U+0000–U+001F (except `\n`/`\t`) and U+007F–U+009F.
 */
function stripControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isC0 = code <= 0x1f && code !== 0x0a && code !== 0x09;
    const isC1 = code >= 0x7f && code <= 0x9f;
    if (isC0 || isC1) continue;
    out += ch;
  }
  return out;
}

/**
 * #393: build the agent's actual chat reply from a completed session's deliverable. The fleet ran and
 * produced real work; without posting it as a MESSAGE the owner only ever sees a board card and reads
 * the channel as "no response". The body is the deliverable text, trimmed, control-chars stripped
 * (newlines/tabs preserved — a deliverable is multi-line), and length-capped. A blank deliverable
 * returns `""` so the caller skips posting. Pure (no clock/IO) ⇒ unit-tested.
 */
export function formatDeliverableMessage(task: string, deliverable: string): string {
  const body = stripControlChars(deliverable).trim();
  if (!body) return "";
  // `task` is accepted for parity with the surfacing sink (and a possible future context line); the
  // deliverable text already stands on its own as the reply, so we post it verbatim.
  void task;
  return body.length > MAX_REPLY_CHARS ? body.slice(0, MAX_REPLY_CHARS) : body;
}
