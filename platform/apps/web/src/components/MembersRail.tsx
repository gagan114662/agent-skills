/**
 * Right-edge roster: every workspace member — humans AND agents — with a live presence dot.
 * Agents are surfaced as first-class members (agent-first), grouped and badged distinctly.
 */
import { useAppState } from "../store/StoreContext.js";
import { Avatar, KindBadge, PresenceDot } from "./Primitives.js";
import type { DirectoryEntry } from "../store/store.js";
import type { PresenceStatus } from "../api/types.js";

/**
 * Presence for a member's dot (#166, QA bug 13). Self is always online. An explicit gateway presence
 * event wins. Otherwise agents default to "online" — they're standing department personas (in the
 * directory because the fleet is enabled), so they should read available rather than the grey/offline
 * they always showed before (they never emit WS presence events). Humans keep offline-by-default.
 */
function presenceFor(
  m: DirectoryEntry,
  selfId: string | undefined,
  presence: Record<string, PresenceStatus>,
): PresenceStatus | undefined {
  if (m.id === selfId) return "online";
  if (presence[m.id]) return presence[m.id];
  return m.kind === "agent" ? "online" : undefined;
}

export function MembersRail(): React.JSX.Element {
  const { directory, presence, identity } = useAppState();
  const members = Object.values(directory);
  const humans = members.filter((m) => m.kind === "human");
  const agents = members.filter((m) => m.kind === "agent");

  return (
    <aside className="members" aria-label="Members">
      <header className="members__head">Members</header>
      <Group label={`Agents · ${agents.length}`} members={agents} presence={presence} selfId={identity?.memberId} />
      <Group label={`People · ${humans.length}`} members={humans} presence={presence} selfId={identity?.memberId} />
    </aside>
  );
}

function Group({
  label,
  members,
  presence,
  selfId,
}: {
  label: string;
  members: DirectoryEntry[];
  presence: Record<string, import("../api/types.js").PresenceStatus>;
  selfId?: string;
}): React.JSX.Element | null {
  if (members.length === 0) return null;
  return (
    <div className="members__group">
      <div className="members__grouphead">{label}</div>
      <ul>
        {members
          .slice()
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map((m) => (
            <li key={m.id} className="memberrow">
              <Avatar name={m.displayName} kind={m.kind} />
              <span className="memberrow__name">
                {m.displayName}
                {m.id === selfId && <span className="memberrow__you"> (you)</span>}
              </span>
              {m.kind === "agent" && <KindBadge kind="agent" />}
              <PresenceDot status={presenceFor(m, selfId, presence)} />
            </li>
          ))}
      </ul>
    </div>
  );
}
