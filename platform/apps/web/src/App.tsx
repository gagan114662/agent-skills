/** App root: the auth boundary wrapping the workspace shell. */
import { AuthGate } from "./components/AuthGate.js";
import { StatusPage } from "./components/StatusPage.js";
import { SupportTicketStatus } from "./components/SupportTicketStatus.js";
import { PublicDogfood } from "./components/dogfood/PublicDogfood.js";
import { TheaterView } from "./components/theater/TheaterView.js";
import { DemoSandbox } from "./components/demo/DemoSandbox.js";
import { OnboardingExperience } from "./components/onboarding/OnboardingExperience.js";
import { LiveEverydayShell } from "./components/everyday/LiveEverydayShell.js";
import { navigate, useRoute } from "./routing.js";

/** The public status page (#148) lives at `/status/:slug` — rendered BEFORE the auth boundary so it
 * needs no session (path-based, keeping the no-router shell). Everything else is the authed app. */
const STATUS_PATH = /^\/status\/([^/]+)\/?$/;
/** Public support-ticket status page (#919), linked from widget confirmations. */
const SUPPORT_STATUS_PATH = /^\/support\/status\/?$/;
/** Public dogfood feed (#461): ipop marketing ipop with real redacted trace receipts. */
const DOGFOOD_PATH = /^\/dogfood(?:\/([^/]+))?\/?$/;
/** The no-signup instant demo / sandbox (#610) — a PUBLIC surface at `/demo` (or `/sandbox`), rendered
 * BEFORE the auth boundary: a prospect watches a personalized deliverable build with zero account. */
const DEMO_PATH = /^\/(?:demo|sandbox)\/?$/;
/** The live agent-theater (#624) — an authed surface at `/theater`; watch the fleet work in real time. */
const THEATER_PATH = /^\/theater\/?$/;
/** The #784 first-run onboarding experience — now the DEFAULT public landing. Root `/` and `/welcome` both
 * open the warm door (the onboarding flag is ON by default; set VITE_RELOAD_ONBOARDING_V2=false to restore
 * the marketing landing). Rendered before the auth boundary: a brand-new visitor lands here with no session. */
const WELCOME_PATH = /^\/(?:welcome\/?)?$/;
/** The everyday workspace shell (#784) — the linzumi-calm chat-first redesign, also reachable at its own
 * `/everyday` path. It is the live default for a signed-in workspace (see {@link AuthedHome}). */
const EVERYDAY_PATH = /^\/everyday\/?$/;

/**
 * The signed-in home. The iMessage/Codex room is the product now; do not let stale deployment flags
 * send signed-in users back to the legacy console.
 */
function AuthedHome(): React.JSX.Element {
  return <LiveEverydayShell />;
}

export function App(): React.JSX.Element {
  // useRoute keeps these top-level branches in sync with client navigation (and browser back/forward).
  const path = useRoute();
  const status = STATUS_PATH.exec(path);
  if (status) return <StatusPage slug={decodeURIComponent(status[1]!)} />;
  if (SUPPORT_STATUS_PATH.test(path)) return <SupportTicketStatus />;
  const dogfood = DOGFOOD_PATH.exec(path);
  if (dogfood) return <PublicDogfood slug={decodeURIComponent(dogfood[1] ?? "ipop")} />;

  // #784: root `/` and `/welcome` are auth-aware. Logged-out visitors get the warm onboarding door, while
  // signed-in members land directly in the everyday shell instead of seeing the public/legacy front door.
  if (WELCOME_PATH.test(path)) {
    return (
      <AuthGate publicEntry={<OnboardingExperience onEnterApp={() => navigate("/everyday")} />}>
        <AuthedHome />
      </AuthGate>
    );
  }

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

  // The everyday-shell redesign (#784) also has its own explicit `/everyday` route.
  if (EVERYDAY_PATH.test(path)) {
    return (
      <AuthGate>
        <LiveEverydayShell />
      </AuthGate>
    );
  }

  return (
    <AuthGate>
      <AuthedHome />
    </AuthGate>
  );
}
