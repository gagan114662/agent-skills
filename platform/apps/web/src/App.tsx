/** App root: the auth boundary wrapping the workspace shell. */
import { AuthGate } from "./components/AuthGate.js";
import { Workspace } from "./components/Workspace.js";
import { StatusPage } from "./components/StatusPage.js";

/** The public status page (#148) lives at `/status/:slug` — rendered BEFORE the auth boundary so it
 * needs no session (path-based, keeping the no-router shell). Everything else is the authed app. */
const STATUS_PATH = /^\/status\/([^/]+)\/?$/;

export function App(): React.JSX.Element {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const status = STATUS_PATH.exec(path);
  if (status) return <StatusPage slug={decodeURIComponent(status[1]!)} />;

  return (
    <AuthGate>
      <Workspace />
    </AuthGate>
  );
}
