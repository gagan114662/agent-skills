/** App root: the auth boundary wrapping the workspace shell. */
import { AuthGate } from "./components/AuthGate.js";
import { Workspace } from "./components/Workspace.js";
import { StatusPage } from "./components/StatusPage.js";
import { TheaterView } from "./components/theater/TheaterView.js";
import { useRoute } from "./routing.js";

/** The public status page (#148) lives at `/status/:slug` — rendered BEFORE the auth boundary so it
 * needs no session (path-based, keeping the no-router shell). Everything else is the authed app. */
const STATUS_PATH = /^\/status\/([^/]+)\/?$/;
/** The live agent-theater (#624) — an authed surface at `/theater`; watch the fleet work in real time. */
const THEATER_PATH = /^\/theater\/?$/;

export function App(): React.JSX.Element {
  // useRoute keeps these top-level branches in sync with client navigation (and browser back/forward).
  const path = useRoute();
  const status = STATUS_PATH.exec(path);
  if (status) return <StatusPage slug={decodeURIComponent(status[1]!)} />;

  // The theater needs a session (workspace-scoped stream), so it lives inside the auth boundary.
  if (THEATER_PATH.test(path)) {
    return (
      <AuthGate>
        <TheaterView />
      </AuthGate>
    );
  }

  return (
    <AuthGate>
      <Workspace />
    </AuthGate>
  );
}
