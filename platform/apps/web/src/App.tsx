/** App root: the auth boundary wrapping the workspace shell. */
import { AuthGate } from "./components/AuthGate.js";
import { Workspace } from "./components/Workspace.js";
import { StatusPage } from "./components/StatusPage.js";
import { TheaterView } from "./components/theater/TheaterView.js";
import { DemoSandbox } from "./components/demo/DemoSandbox.js";
import { OnboardingExperience } from "./components/onboarding/OnboardingExperience.js";
import { ONBOARDING_V2_ENABLED, shouldShowOnboardingV2 } from "./components/onboarding/onboarding-flag.js";
import { useRoute } from "./routing.js";

/** The public status page (#148) lives at `/status/:slug` — rendered BEFORE the auth boundary so it
 * needs no session (path-based, keeping the no-router shell). Everything else is the authed app. */
const STATUS_PATH = /^\/status\/([^/]+)\/?$/;
/** The no-signup instant demo / sandbox (#610) — a PUBLIC surface at `/demo` (or `/sandbox`), rendered
 * BEFORE the auth boundary: a prospect watches a personalized deliverable build with zero account. */
const DEMO_PATH = /^\/(?:demo|sandbox)\/?$/;
/** The live agent-theater (#624) — an authed surface at `/theater`; watch the fleet work in real time. */
const THEATER_PATH = /^\/theater\/?$/;
/** The #784 first-run onboarding experience — a PUBLIC surface at `/welcome`, default-OFF behind its flag.
 * Rendered before the auth boundary: a brand-new visitor lands on the warm door with no session yet. */
const WELCOME_PATH = /^\/welcome\/?$/;

export function App(): React.JSX.Element {
  // useRoute keeps these top-level branches in sync with client navigation (and browser back/forward).
  const path = useRoute();
  const status = STATUS_PATH.exec(path);
  if (status) return <StatusPage slug={decodeURIComponent(status[1]!)} />;

  // The new onboarding experience is fully public and gated default-OFF; when its flag is unset, /welcome
  // simply falls through to the normal app, so production is untouched until the flag flips.
  if (WELCOME_PATH.test(path) && shouldShowOnboardingV2({ flagOn: ONBOARDING_V2_ENABLED })) {
    return <OnboardingExperience />;
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

  return (
    <AuthGate>
      <Workspace />
    </AuthGate>
  );
}
