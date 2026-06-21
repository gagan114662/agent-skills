/**
 * Left rail (#378) — the reload.chat sidebar: a top search box, then PINNED, CHANNELS, and DIRECT MESSAGES
 * (humans AND the seeded agent personas, each a DM target). Selecting a channel switches the centre feed;
 * selecting a DM opens the 1:1 with that member (an agent → its department channel, via
 * {@link resolveDmChannelId}). ⌘K focuses the search. The structure is a pure projection of the existing
 * store ({@link buildSidebarModel}) — no new backend, no new state on the wire.
 *
 * SAFETY (#200): channel + member names are DATA, rendered as React text only (never markup); selecting a
 * DM only ever resolves to an EXISTING channel id, never creates one. Copy comes from brand.ts.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { CONSOLE } from "../brand.js";
import { Wordmark } from "./Wordmark.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import type { DirectoryEntry } from "../store/store.js";
import {
  buildSidebarModel,
  resolveDmChannelId,
  type SidebarChannel,
  type SidebarDm,
} from "./console/coordination-nav.js";

const COPY = CONSOLE.coordination.sidebar;

export interface ChannelSidebarProps {
  /** When provided, a DM click delegates to the parent (so it can reframe the centre pane as a 1:1). */
  onSelectDm?: (member: DirectoryEntry, channelId: string | null) => void;
  /** Notified after a channel row is picked (so the parent can drop any DM framing). */
  onSelectChannel?: (channelId: string) => void;
  /** The member id of the active DM, so its row highlights even when several DMs map to one channel. */
  activeDmMemberId?: string | null;
  /** #510: open the workspace settings overlay from the title switcher's "New product" / "Settings" items. */
  onOpenSettings?: () => void;
}

export function ChannelSidebar({
  onSelectDm,
  onSelectChannel,
  activeDmMemberId,
  onOpenSettings,
}: ChannelSidebarProps = {}): React.JSX.Element {
  const { channels, activeChannelId, directory, identity } = useAppState();
  const store = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const model = buildSidebarModel(channels, directory, identity?.memberId, query);

  // Navigating to another channel dismisses an open add-channel field (#168) so a half-typed name
  // never lingers across conversations. (Opening the field doesn't change the active channel.)
  useEffect(() => {
    setAdding(false);
    setName("");
  }, [activeChannelId]);

  // ⌘K / Ctrl-K focuses the search box (the reload.chat omni-jump). Scoped to this rail's lifetime.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  function selectChannel(channelId: string): void {
    onSelectChannel?.(channelId);
    void store.selectChannel(channelId);
  }

  function selectDm(member: DirectoryEntry): void {
    const channelId = resolveDmChannelId(member, channels);
    if (onSelectDm) {
      onSelectDm(member, channelId);
      return;
    }
    // Standalone (no parent): open the resolved 1:1 channel; a null resolution is a safe no-op (#200).
    if (channelId) void store.selectChannel(channelId);
  }

  const hasResults = model.pinned.length > 0 || model.channels.length > 0 || model.dms.length > 0;

  return (
    <nav className="sidebar" aria-label={CONSOLE.coordination.open}>
      <header className="sidebar__head">
        <div className="sidebar__brand">
          <Wordmark />
        </div>
        {/* #510: the workspace title is a real switcher button now — clicking it opens the menu instead of
            falling through to the channel behind it. */}
        {identity && <WorkspaceSwitcher onOpenSettings={onOpenSettings} />}
      </header>

      <div className="sidebar__search">
        <input
          ref={searchRef}
          className="sidebar__searchinput"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={COPY.searchPlaceholder}
          aria-label={COPY.searchLabel}
        />
        <kbd className="sidebar__searchhint" aria-hidden="true">
          {COPY.searchHint}
        </kbd>
      </div>

      {model.pinned.length > 0 && (
        <Section title={COPY.pinned}>
          <ul className="channellist">
            {model.pinned.map((c) => (
              <ChannelRow key={c.id} channel={c} active={c.id === activeChannelId} onSelect={selectChannel} />
            ))}
          </ul>
        </Section>
      )}

      <Section
        title={COPY.channels}
        action={
          <button className="iconbtn" aria-label={COPY.addChannel} title={COPY.addChannel} onClick={() => setAdding((v) => !v)}>
            +
          </button>
        }
      >
        {adding && (
          <form
            className="sidebar__addform"
            onSubmit={onCreate}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeAdd();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={COPY.newChannelPlaceholder}
            />
            <button className="btn btn--small" type="submit">
              {COPY.create}
            </button>
          </form>
        )}
        <ul className="channellist">
          {model.channels.map((c) => (
            <ChannelRow key={c.id} channel={c} active={c.id === activeChannelId} onSelect={selectChannel} />
          ))}
        </ul>
      </Section>

      {model.dms.length > 0 && (
        <Section title={COPY.directMessages}>
          <ul className="channellist">
            {model.dms.map((d) => (
              <DmRow
                key={d.memberId}
                dm={d}
                active={activeDmMemberId === d.memberId}
                onSelect={() => selectDm(directory[d.memberId] ?? { id: d.memberId, kind: d.kind, displayName: d.displayName })}
              />
            ))}
          </ul>
        </Section>
      )}

      {query.trim() !== "" && !hasResults && <p className="sidebar__empty">{COPY.noMatches}</p>}
    </nav>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="sidebar__section">
      <div className="sidebar__sectionhead">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  onSelect,
}: {
  channel: SidebarChannel;
  active: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const dept = channel.color;
  return (
    <li>
      <button
        className={`channelrow${active ? " channelrow--active" : ""}${dept ? " channelrow--dept" : ""}`}
        onClick={() => onSelect(channel.id)}
        aria-current={active ? "true" : undefined}
        style={dept ? ({ "--dept": dept } as React.CSSProperties) : undefined}
      >
        <span className="channelrow__hash">#</span>
        {channel.name}
      </button>
    </li>
  );
}

function DmRow({
  dm,
  active,
  onSelect,
}: {
  dm: SidebarDm;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        className={`channelrow dmrow${active ? " channelrow--active" : ""}`}
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
      >
        <span
          className={`dmrow__dot${dm.kind === "agent" ? " dmrow__dot--agent" : ""}`}
          style={dm.color ? ({ "--dot": dm.color } as React.CSSProperties) : undefined}
          aria-hidden="true"
        />
        <span className="dmrow__name">{dm.displayName}</span>
        {dm.self && <span className="dmrow__you"> ({COPY.you})</span>}
      </button>
    </li>
  );
}
