/**
 * The agent-coordination surface (#352/#378/#384) — the reload.chat-style chat app: a left rail (search ·
 * pinned · channels · DMs), a centre message feed + composer, and a right members rail. For the named owner
 * workspace this is the WHOLE app (#378): ConsoleView mounts it in place of the board, so there is no kanban
 * and no projects/task sidebar — chat is the product.
 *
 * #384: the surface is now ONLY header + feed + composer + members — matching reload.team. The old
 * "Team coordination" preamble and the Mission-control running-sessions TABLE are gone: they were ipop-only
 * chrome that pushed the feed down and broke the clean look. Running-session status already arrives as
 * in-channel agent messages (the #370 bridge: "✅ session completed (exit 0)"); the live indicator survives
 * only as a small "N running" pill in the app header (ConsoleView), never a table above the feed. The
 * accessible region label is preserved so the surface stays nameable to assistive tech and tests.
 *
 * It adds NO new backend: every panel self-wires to the EXISTING channels / messagesByChannel / directory
 * store. Flat navigation is owned here: this view holds the one selection (a channel, or a DM peer) and
 * threads it to the sidebar (highlight) and the message pane (1:1 framing). Selecting a DM resolves to that
 * member's EXISTING 1:1 channel (an agent → its department channel) — never a fabricated one.
 *
 * SAFETY (#200): every channel / message / agent string rendered here is DATA — React text only, never
 * `dangerouslySetInnerHTML` — so agent-authored content can never become markup or instructions. The surface
 * is read + steer (chat) only; it opens NO new money / irreversible action path. Live / irreversible actions
 * keep flowing through the #13 approval gate (reachable via the "waiting on you" control), untouched.
 */
import { useState } from "react";
import { useStore } from "../../store/StoreContext.js";
import type { DirectoryEntry } from "../../store/store.js";
import { ChannelSidebar } from "../ChannelSidebar.js";
import { MessagePane } from "../MessagePane.js";
import { ThreadPanel } from "../ThreadPanel.js";
import { MembersRail } from "../MembersRail.js";
import { CONSOLE } from "../../brand.js";

export function CoordinationView(): React.JSX.Element {
  const store = useStore();
  // The active DM peer (a 1:1 framing over that member's channel), or null for a plain channel view.
  const [dmPeer, setDmPeer] = useState<DirectoryEntry | null>(null);

  // A DM opens the member's 1:1 channel and frames the pane as a direct message — but only when a real 1:1
  // channel resolves (an agent → its department channel). With no resolvable channel we keep the current
  // view rather than reframe over unrelated messages (and #200: we never create a channel to satisfy it).
  function handleSelectDm(member: DirectoryEntry, channelId: string | null): void {
    if (!channelId) {
      setDmPeer(null);
      return;
    }
    setDmPeer(member);
    void store.selectChannel(channelId);
  }

  // Picking a channel directly drops any DM framing (the header returns to the channel hash).
  function handleSelectChannel(): void {
    setDmPeer(null);
  }

  return (
    <div className="coord" aria-label={CONSOLE.coordination.title}>
      {/* #384: header + feed + composer + members ONLY. No preamble, no mission-control table — the channel
          header (MessagePane), feed, and composer fill the surface; running status lives in-channel + a small
          header pill (ConsoleView). The `aria-label` above keeps the region nameable without visible chrome. */}
      <div className="coord__body">
        <ChannelSidebar
          onSelectDm={handleSelectDm}
          onSelectChannel={handleSelectChannel}
          activeDmMemberId={dmPeer?.id ?? null}
        />
        <MessagePane dmPeer={dmPeer} />
        <ThreadPanel />
        <MembersRail />
      </div>
    </div>
  );
}
