/** Small presentational primitives shared across the workspace UI. */
import type { MemberKind, PresenceStatus } from "../api/types.js";

/** A presence indicator dot. Unknown presence renders as offline/grey. */
export function PresenceDot({ status }: { status?: PresenceStatus }): React.JSX.Element {
  const s = status ?? "offline";
  return <span className={`presence presence--${s}`} title={s} aria-label={`presence: ${s}`} />;
}

/** A pill marking whether a member is a human or an agent (agents are emphasized — agent-first). */
export function KindBadge({ kind }: { kind: MemberKind }): React.JSX.Element {
  return <span className={`kind kind--${kind}`}>{kind === "agent" ? "AGENT" : "HUMAN"}</span>;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
  return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
}

/** An initials avatar, tinted differently for agents vs humans. */
export function Avatar({ name, kind }: { name: string; kind: MemberKind }): React.JSX.Element {
  return (
    <span className={`avatar avatar--${kind}`} aria-hidden="true">
      {kind === "agent" ? "◆" : initials(name)}
    </span>
  );
}
