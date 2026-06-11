/** Small presentational primitives shared across the workspace UI. */
import type { MemberKind, PresenceStatus } from "../api/types.js";
import { agentColor } from "../brand.js";
import { PopMark } from "./PopMark.js";

/** A presence indicator dot. Unknown presence renders as offline/grey. */
export function PresenceDot({ status }: { status?: PresenceStatus }): React.JSX.Element {
  const s = status ?? "offline";
  return <span className={`presence presence--${s}`} title={s} aria-label={`presence: ${s}`} />;
}

/**
 * A pill marking whether a member is a human or an agent (agents are emphasized — agent-first). For
 * agents, `color` tints the chip to the department spectrum hue (#145 criterion #4).
 */
export function KindBadge({ kind, color }: { kind: MemberKind; color?: string }): React.JSX.Element {
  const dept = kind === "agent" && color;
  const style = dept ? ({ "--pop-color": color } as React.CSSProperties) : undefined;
  return (
    <span className={`kind kind--${kind}${dept ? " kind--dept" : ""}`} style={style}>
      {kind === "agent" ? "AGENT" : "HUMAN"}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
  return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
}

/**
 * An avatar. Humans get an initials tile; agents get a department-coloured Pop Mark (#145 criterion
 * #4) — the named fleet leads (Scout, Echo, …) wear their spectrum hue, other agents the agent violet.
 */
export function Avatar({ name, kind }: { name: string; kind: MemberKind }): React.JSX.Element {
  if (kind === "agent") {
    const color = agentColor(name);
    return (
      <span
        className="avatar avatar--agent"
        aria-hidden="true"
        style={color ? ({ "--pop-color": color } as React.CSSProperties) : undefined}
      >
        <PopMark color={color} />
      </span>
    );
  }
  return (
    <span className="avatar avatar--human" aria-hidden="true">
      {initials(name)}
    </span>
  );
}
