/** Left rail: workspace identity, channel list (public + DMs), and a create-channel control. */
import { useState, type FormEvent } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { BRAND } from "../brand.js";
import type { Channel } from "../api/types.js";

export function ChannelSidebar(): React.JSX.Element {
  const { channels, activeChannelId, identity } = useAppState();
  const store = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const publicChannels = channels.filter((c) => c.kind === "public");
  const dms = channels.filter((c) => c.kind === "dm");

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setName("");
    setAdding(false);
    await store.createChannel(trimmed);
  }

  return (
    <nav className="sidebar" aria-label="Channels">
      <header className="sidebar__head">
        <div className="sidebar__brand">
          <span className="auth__mark">{BRAND.mark}</span> {BRAND.name}
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
          <form className="sidebar__addform" onSubmit={onCreate}>
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
  return (
    <li>
      <button
        className={`channelrow${active ? " channelrow--active" : ""}`}
        onClick={() => onSelect(channel.id)}
        aria-current={active ? "true" : undefined}
      >
        <span className="channelrow__hash">{channel.kind === "dm" ? "@" : "#"}</span>
        {label}
      </button>
    </li>
  );
}
