/**
 * The agent-coordination surface (#352) — re-mounts the reload.chat-style coordination components that
 * already exist in the tree but were orphaned (imported by nothing) when console v5 collapsed the product to
 * the board. It is gated behind the default-OFF, owner-workspace-first {@link
 * ../../components/console/coordination-flag} so it shows ONLY for the named owner workspace, and it adds NO
 * new backend: every panel self-wires to the EXISTING channels / messagesByChannel / directory store, and
 * the live strip reads the #147 mission-control seam through {@link MissionControlPanel}.
 *
 * SAFETY (#200): every channel / message / agent string rendered here is DATA — React text only, never
 * `dangerouslySetInnerHTML` (there is none in any of these components) — so agent-authored content can never
 * become markup or instructions. The surface is read + steer (chat) only; it opens NO new money / irreversible
 * action path. Live / irreversible actions keep flowing through the #13 approval gate on the board, untouched.
 */
import { ChannelSidebar } from "../ChannelSidebar.js";
import { MessagePane } from "../MessagePane.js";
import { ThreadPanel } from "../ThreadPanel.js";
import { MembersRail } from "../MembersRail.js";
import { MissionControlPanel } from "../MissionControlPanel.js";
import { CONSOLE } from "../../brand.js";

/**
 * The two-row coordination workspace: a live mission-control strip (#147) over the reload.chat four-column
 * grid (channels · messages · thread · members). The grid template (`240px 1fr auto auto`) matches the
 * styling the orphaned components were built against; the `auto` thread / members columns collapse when
 * empty (ThreadPanel renders null with no open thread).
 */
export function CoordinationView(): React.JSX.Element {
  return (
    <div className="coord" aria-label={CONSOLE.coordination.title}>
      <header className="coord__head">
        <h2 className="coord__title">{CONSOLE.coordination.title}</h2>
        <p className="coord__sub">{CONSOLE.coordination.sub}</p>
      </header>
      <section className="coord__live" aria-label={CONSOLE.coordination.liveLabel}>
        <MissionControlPanel />
      </section>
      <div className="coord__body">
        <ChannelSidebar />
        <MessagePane />
        <ThreadPanel />
        <MembersRail />
      </div>
    </div>
  );
}
