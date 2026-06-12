/** Left rail: workspace identity, channel list (public + DMs), and a create-channel control. */
import { useEffect, useState, type FormEvent } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { departmentColor } from "../brand.js";
import { Wordmark } from "./Wordmark.js";
import type { Channel } from "../api/types.js";

export function ChannelSidebar(): React.JSX.Element {
  const { channels, activeChannelId, identity } = useAppState();
  const store = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const publicChannels = channels.filter((c) => c.kind === "public");
  const dms = channels.filter((c) => c.kind === "dm");

  // Navigating to another channel dismisses an open add-channel field (#168) so a half-typed name
  // never lingers across conversations. (Opening the field doesn't change the active channel.)
  useEffect(() => {
    setAdding(false);
    setName("");
  }, [activeChannelId]);

  function closeAdd(): void {
    setAdding(false);
    setName("");
  }

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    closeAdd();
    await store.createChannel(trimmed);
  }

  return (
    <nav className="sidebar" aria-label="Channels">
      <header className="sidebar__head">
        <div className="sidebar__brand">
          <Wordmark />
        </div>
        {identity && <div className="sidebar__ws">workspace · {identity.workspaceId.slice(0, 8)}</div>}
      </header>

      <div className="sidebar__section">
        <div className="sidebar__sectionhead">
          <span>Channels</span>
          <button
            className="iconbtn"
            aria-label="Add channel"
            title="Add channel"
            onClick={() => setAdding((v) => !v)}
          >
            +
          </button>
        </div>

        {adding && (
          <form
            className="sidebar__addform"
            onSubmit={onCreate}
            onBlur={(e) => {
              // Focus moving to the Create button stays inside the form (so Enter/click can submit);
              // focus leaving the form entirely (blur/navigation) dismisses the field (#168).
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeAdd();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New channel name"
            />
            <button className="btn btn--small" type="submit">
              Create
            </button>
          </form>
        )}

        <ul className="channellist">
          {publicChannels.map((c) => (
            <ChannelRow key={c.id} channel={c} active={c.id === activeChannelId} onSelect={store.selectChannel} />
          ))}
        </ul>
      </div>

      {dms.length > 0 && (
        <div className="sidebar__section">
          <div className="sidebar__sectionhead">
            <span>Direct messages</span>
          </div>
          <ul className="channellist">
            {dms.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                active={c.id === activeChannelId}
                onSelect={store.selectChannel}
              />
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}

function ChannelRow({
  channel,
  active,
  onSelect,
}: {
  channel: Channel;
  active: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const label = channel.kind === "dm" ? "direct message" : (channel.name ?? "channel");
  // Department channels (#123 fleet) wear their spectrum hue on the hash glyph (#138 pop identity).
  const dept = channel.kind === "dm" ? undefined : departmentColor(channel.name);
  return (
    <li>
      <button
        className={`channelrow${active ? " channelrow--active" : ""}${dept ? " channelrow--dept" : ""}`}
        onClick={() => onSelect(channel.id)}
        aria-current={active ? "true" : undefined}
        style={dept ? ({ "--dept": dept } as React.CSSProperties) : undefined}
      >
        <span className="channelrow__hash">{channel.kind === "dm" ? "@" : "#"}</span>
        {label}
      </button>
    </li>
  );
}
