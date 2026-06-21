/**
 * The agent execution-tool framework (#464). Until now every department agent carried only read/draft tools
 * (`Read`/`Grep`/`Glob`/`WebSearch`/`WebFetch` — see `marketing/blueprint.ts`): it could audit and draft,
 * but nothing it produced ever left the building on its own. This module adds the missing class — EXECUTION
 * tools that change the world (publish content, post to a network, commit ad spend) — behind one structural
 * rule the whole framework enforces: **an execution tool NEVER fires; it only parks a #13 approval.** The
 * action runs later, through the existing post-approval executor, once a human says yes (ADR-0013/#243).
 *
 * This is the PURE surface (types only, no IO) — the registry, the gating decision, and the service import
 * from here. It complements (does not duplicate) the per-department services (`social`/`hosted`/`outreach`):
 * those own the live actuation behind the gate; this is the single agent-facing seam that classifies the
 * human-approval boundary, parks the request, and writes the audit entry for every tool an agent invokes.
 */

/** What a tool's blast radius is once approved — the human-approval boundary the owner is shown. */
export const TOOL_VISIBILITIES = ["public", "outbound", "money"] as const;
export type ToolVisibility = (typeof TOOL_VISIBILITIES)[number];

/** The result of validating + normalizing a tool's arguments. `prepare` is pure (no IO, no parking). */
export type ToolPreparation =
  | { ok: false; error: string }
  | {
      ok: true;
      /** A human-readable, injection-safe one-liner for the #13 queue (built structurally from validated args). */
      summary: string;
      /** Routing-only fields the executor can trust (ids/slugs/networks) — NEVER free-form content. */
      payload: Record<string, unknown>;
      /** The committed spend, when this is a money tool; `null` for a non-spend (public/outbound) tool. */
      amount: number | null;
    };

/**
 * One execution tool an agent can invoke. Declarative + pure: it names the #13 action it parks, its
 * visibility boundary, the department that carries it, and a single pure {@link ToolSpec.prepare} that
 * validates the args and produces the (injection-safe) summary + routing payload. The tool has NO `execute`
 * — actuation is the per-department service's job, behind the human gate.
 */
export interface ExecutionToolSpec {
  /** Stable tool id, e.g. `content.publish`. The verb an agent (or the runtime) requests. */
  readonly name: string;
  /** Short human label for the console (no internal agent chatter). */
  readonly label: string;
  /** One-line description of the real-world effect (no internal agent chatter). */
  readonly description: string;
  /** The owning department key (e.g. `content`) — used to advertise a department's execution tools. */
  readonly department: string;
  /** The #13 approval-gated action type this tool parks (an existing approval taxonomy entry). */
  readonly gatedAction: string;
  /** The human-approval boundary this tool crosses once approved. */
  readonly visibility: ToolVisibility;
  /** Validate + normalize args into a parking payload. Pure, total, fail-closed. */
  prepare(args: unknown): ToolPreparation;
}
