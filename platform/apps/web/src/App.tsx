/** App root: the auth boundary wrapping the workspace shell. */
import { AuthGate } from "./components/AuthGate.js";
import { Workspace } from "./components/Workspace.js";
import { StatusPage } from "./components/StatusPage.js";
import { TheaterView } from "./components/theater/TheaterView.js";
import { DemoSandbox } from "./components/demo/DemoSandbox.js";
import { EverydayShell } from "./components/everyday/EverydayShell.js";
import { EVERYDAY_SHELL_ENABLED } from "./components/everyday/everyday-shell-flag.js";
import { useRoute } from "./routing.js";

/** The public status page (#148) lives at `/status/:slug` — rendered BEFORE the auth boundary so it
 * needs no session (path-based, keeping the no-router shell). Everything else is the authed app. */
const STATUS_PATH = /^\/status\/([^/]+)\/?$/;
/** The no-signup instant demo / sandbox (#610) — a PUBLIC surface at `/demo` (or `/sandbox`), rendered
 * BEFORE the auth boundary: a prospect watches a personalized deliverable build with zero account. */
const DEMO_PATH = /^\/(?:demo|sandbox)\/?$/;
/** The live agent-theater (#624) — an authed surface at `/theater`; watch the fleet work in real time. */
const THEATER_PATH = /^\/theater\/?$/;
/** The everyday workspace shell (#784) — the linzumi-calm chat-first redesign, an authed surface at
 * `/everyday`. GATED by the default-OFF `VITE_EVERYDAY_SHELL` flag: production sets no env ⇒ the route falls
 * through to today's console, so nothing changes; the owner enables it on their own preview to validate the
 * redesign against the references. Reversible: unset the env and the route is gone. */
const EVERYDAY_PATH = /^\/everyday\/?$/;

export function App(): React.JSX.Element {
  // useRoute keeps these top-level branches in sync with client navigation (and browser back/forward).
  const path = useRoute();
  const status = STATUS_PATH.exec(path);
  if (status) return <StatusPage slug={decodeURIComponent(status[1]!)} />;

  // The instant demo is fully public — no session, no auth — so it renders before the auth boundary.
  if (DEMO_PATH.test(path)) return <DemoSandbox />;

  // The theater needs a session (workspace-scoped stream), so it lives inside the auth boundary.
  if (THEATER_PATH.test(path)) {
    return (
      <AuthGate>
        <TheaterView />
      </AuthGate>
    );
  }

  // The everyday-shell redesign (#784) — only when the owner has enabled the default-OFF flag; otherwise the
  // route falls through to the normal workspace below, so production is byte-for-byte unchanged.
  if (EVERYDAY_SHELL_ENABLED && EVERYDAY_PATH.test(path)) {
    return (
      <AuthGate>
        <EverydayShell />
      </AuthGate>
    );
  }

  return (
    <AuthGate>
      <Workspace />
    </AuthGate>
  );
}
