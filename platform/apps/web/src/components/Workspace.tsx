/**
 * The authed shell (console v5). There is no top nav anymore — the whole product is the two-pane console
 * (left projects → sessions, center board, drawer to dive in). This wrapper exists only to host the
 * full-height `.workspace` frame; every surface, including the few off-board overlays (settings, pricing),
 * lives inside {@link ConsoleView}. The old multi-tab shell was superseded by the #199 → v5 redesign.
 */
import { ConsoleView } from "./console/ConsoleView.js";

export function Workspace(): React.JSX.Element {
  return (
    <div className="workspace">
      <ConsoleView />
    </div>
  );
}
