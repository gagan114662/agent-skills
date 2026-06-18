/**
 * Connection-health chip (#365) — presentational.
 *
 * The fleet runs SUBSCRIPTION-ONLY (#246): until the owner connects their own Claude, every @mention
 * replies "reconnect your Claude" and the board stays empty. This header chip makes that state visible at
 * a glance — connected / not connected / token expired — and, when something needs attention, IS the button
 * that opens Settings → Connect Claude (the one owner action that unlocks real agent runs).
 *
 * Gated default-OFF + owner-workspace-first by `connect-health-flag.ts`, so it renders for nobody in prod
 * unless the owner opts in; the parent only mounts it when the gate passes. Pure: it reads `health` and
 * calls `onConnect` — no fetching, no state — so every state is unit-tested without a DOM lifecycle.
 */
import type { ClaudeConnectionHealth } from "../../api/types.js";
import { CONSOLE } from "../../brand.js";

export interface ConnectHealthChipProps {
  /** The health signal, or null while loading (renders nothing — never a flash of a wrong state). */
  health: ClaudeConnectionHealth | null;
  /** Open Settings → Connect Claude. Wired only for the attention states. */
  onConnect: () => void;
}

export function ConnectHealthChip({ health, onConnect }: ConnectHealthChipProps): React.JSX.Element | null {
  if (!health) return null;
  const copy = CONSOLE.connectHealth;

  if (health.state === "connected") {
    // A quiet, non-interactive confirmation — nothing for the owner to do.
    return (
      <span className="connhealth connhealth--ok" role="status" aria-label={copy.label} title={copy.connected}>
        <i aria-hidden="true" />
        {copy.connected}
      </span>
    );
  }

  // not_connected / expired: an actionable button that routes straight to Connect Claude.
  const label = health.state === "expired" ? copy.expired : copy.notConnected;
  return (
    <button
      type="button"
      className={`connhealth connhealth--${health.state === "expired" ? "expired" : "off"}`}
      onClick={onConnect}
      aria-label={copy.label}
      title={health.reason ?? label}
    >
      <i aria-hidden="true" />
      {label}
    </button>
  );
}
