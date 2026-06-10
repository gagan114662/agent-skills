import type { AutonomyLauncher } from "../autonomy/engine.js";

/**
 * The anti-demo admission gate (#96). Wired like the #80 kill-switch/budget guards: a **pure**
 * decision (`decideVentureAdmission`) + an IO controller (`VentureAdmission`) that gathers the
 * inputs, plus a launcher decorator (`ventureGatedLauncher`) that enforces it **only on autonomy
 * launches** — so the venture loop's own Advocate/Reviewer persona sessions (launched directly
 * through the SessionManager) are never blocked by the gate they exist to satisfy.
 *
 * Default OFF: when the workspace's `venture.enabled` is false the decision admits unconditionally,
 * preserving today's behavior for every existing workspace.
 */

export type VentureAdmissionReason = "no_funded_venture";

export type VentureAdmissionDecision = { ok: true } | { ok: false; reason: VentureAdmissionReason };

/** Pure: admit unless the gate is enabled AND there is no passing, unexpired scorecard. */
export function decideVentureAdmission(state: {
  enabled: boolean;
  hasPassingUnexpired: boolean;
}): VentureAdmissionDecision {
  if (!state.enabled) return { ok: true };
  if (!state.hasPassingUnexpired) return { ok: false, reason: "no_funded_venture" };
  return { ok: true };
}

/** Thrown when an autonomy launch is denied for lack of a fundable venture. Mapped to HTTP 403. */
export class VentureAdmissionError extends Error {
  constructor(readonly reason: VentureAdmissionReason) {
    super(`venture admission denied: ${reason}`);
    this.name = "VentureAdmissionError";
  }
}

export interface VentureAdmissionDeps {
  /** Per-workspace resolved venture policy (whether the gate is enabled for this tenant). */
  config: (workspaceId: string) => { enabled: boolean };
  /** Does this workspace currently hold a passing, unexpired scorecard? (Only queried when enabled.) */
  hasPassingUnexpired: (workspaceId: string, now: Date) => Promise<boolean>;
  /** Injectable clock (tests pin it). */
  now?: () => Date;
}

/** IO controller: gathers the inputs and throws on a deny (the #80 `Admission.acquire` shape). */
export class VentureAdmission {
  constructor(private readonly deps: VentureAdmissionDeps) {}

  /** Throw {@link VentureAdmissionError} if this workspace may not launch autonomous work. */
  async check(workspaceId: string): Promise<void> {
    const enabled = this.deps.config(workspaceId).enabled;
    if (!enabled) return; // default OFF — no scorecard query, unchanged behavior
    const now = (this.deps.now ?? (() => new Date()))();
    const hasPassingUnexpired = await this.deps.hasPassingUnexpired(workspaceId, now);
    const decision = decideVentureAdmission({ enabled, hasPassingUnexpired });
    if (!decision.ok) throw new VentureAdmissionError(decision.reason);
  }
}

/** The narrow surface the gated launcher needs (lets tests inject a fake gate). */
export interface VentureGate {
  check(workspaceId: string): Promise<void>;
}

/**
 * Decorate an {@link AutonomyLauncher} so every `launch` first clears the venture gate. `join`/`status`
 * pass straight through. Because the gate short-circuits to admit when disabled, wrapping the default
 * autonomy launcher is safe for every workspace that hasn't opted in.
 */
export function ventureGatedLauncher(inner: AutonomyLauncher, gate: VentureGate): AutonomyLauncher {
  return {
    launch: async (input) => {
      await gate.check(input.workspaceId);
      return inner.launch(input);
    },
    join: (id) => inner.join(id),
    status: (id) => inner.status(id),
  };
}
