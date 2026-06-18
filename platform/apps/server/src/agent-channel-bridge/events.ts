/**
 * Coordination lifecycle events (#370, ADR-0370) — the typed union the bridge turns into channel
 * messages. Each event is a STRUCTURAL description of something that already happened in an audited path
 * (a lead was briefed, an A2A handoff ran, a task was created, an action hit the #13 gate); the bridge
 * neither decides nor performs work — it only narrates. Free-text fields (`goal`, `task`, `title`,
 * `summary`) are UNTRUSTED DATA (#200 §6): the composer sanitizes them before they land in a message body,
 * and the body renders text-only (no markup). Structural fields (`channel`, handles, ids) come from the
 * blueprint / member rows / the approval record, never from model output.
 */

/** The department channel name + the acting agent's @handle that anchor every post. */
export interface CoordinationActor {
  /** The department channel to post into (blueprint channel name, e.g. "seo"). */
  readonly channel: string;
  /** The acting agent's @handle — resolved to its (kind="agent") member row at dispatch. */
  readonly agentHandle: string;
}

/** A lead picks up a brief and posts its plan to the department channel on kickoff. */
export interface LeadPlanEvent extends CoordinationActor {
  readonly kind: "lead_plan";
  /** The owner-authored goal (UNTRUSTED DATA — sanitized before display). */
  readonly goal: string;
}

/** An A2A delegation: the delegating agent posts a short handoff status line. */
export interface HandoffEvent extends CoordinationActor {
  readonly kind: "handoff";
  /** The receiving agent's @handle (structural). */
  readonly toHandle: string;
  /** The handed-off task text (UNTRUSTED DATA — sanitized before display). */
  readonly task: string;
}

/** A task was created/assigned — rendered as an inline task card linking the message to the task id. */
export interface TaskCreatedEvent extends CoordinationActor {
  readonly kind: "task_created";
  /** The task id (structural) — the message → task link. */
  readonly taskId: string;
  /** The task title (UNTRUSTED DATA — sanitized before display). */
  readonly title: string;
  /** The assignee's @handle, if pre-assigned (structural). */
  readonly assigneeHandle?: string;
}

/**
 * An action requires a human decision: the agent @mentions the owner in-channel. This SURFACES the
 * existing #13 approval gate — it is NOT a new action path. No money/irreversible work is performed here;
 * the body merely points the owner at the pending request.
 */
export interface ApprovalRequiredEvent extends CoordinationActor {
  readonly kind: "approval_required";
  /** The pending approval request id (structural) — the message → request link. */
  readonly approvalRequestId: string;
  /** The action's human-readable summary (UNTRUSTED DATA — sanitized before display). */
  readonly summary: string;
}

export type CoordinationEvent =
  | LeadPlanEvent
  | HandoffEvent
  | TaskCreatedEvent
  | ApprovalRequiredEvent;

/** Context the dispatcher resolves from the DB before composing (keeps the composer pure). */
export interface ComposeContext {
  /** The workspace owner's display name, for the approval @mention (undefined ⇒ no name to mention). */
  readonly ownerName?: string;
}

/** What the pure composer produces: where to post, who authors it, and the text-only body. */
export interface ComposedPost {
  /** The department channel name to resolve + post into. */
  readonly channel: string;
  /** The acting agent's @handle to resolve to its member row + author as. */
  readonly authorHandle: string;
  /** The sanitized, text-only message body. */
  readonly body: string;
}

/** The dispatcher's structured outcome (it never throws — failures are reported, not raised). */
export type BridgeResult =
  | { readonly posted: true; readonly messageId: string; readonly channelId: string; readonly authorMemberId: string }
  | {
      readonly posted: false;
      /** Why nothing was posted — `disabled` (flag/owner gate), `no-channel`, `no-author`, or `error`. */
      readonly reason: "disabled" | "no-channel" | "no-author" | "error";
    };
