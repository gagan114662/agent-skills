/** App root: the auth boundary wrapping the workspace shell. */
import { AuthGate } from "./components/AuthGate.js";
import { Workspace } from "./components/Workspace.js";
import { StatusPage } from "./components/StatusPage.js";
import { SupportTicketStatus } from "./components/SupportTicketStatus.js";
import { TheaterView } from "./components/theater/TheaterView.js";
import { DemoSandbox } from "./components/demo/DemoSandbox.js";
import { OnboardingExperience } from "./components/onboarding/OnboardingExperience.js";
import {
  ONBOARDING_V2_ENABLED,
  shouldShowOnboardingV2,
} from "./components/onboarding/onboarding-flag.js";
import { EverydayShell } from "./components/everyday/EverydayShell.js";
import {
  EVERYDAY_SHELL_ENABLED,
  EVERYDAY_SHELL_OWNER_WORKSPACE_ID,
  shouldShowEverydayShell,
} from "./components/everyday/everyday-shell-flag.js";
import { useAppState } from "./store/StoreContext.js";
import { navigate, useRoute } from "./routing.js";

/** The public status page (#148) lives at `/status/:slug` — rendered BEFORE the auth boundary so it
 * needs no session (path-based, keeping the no-router shell). Everything else is the authed app. */
const STATUS_PATH = /^\/status\/([^/]+)\/?$/;
/** Public support-ticket status page (#919), linked from widget confirmations. */
const SUPPORT_STATUS_PATH = /^\/support\/status\/?$/;
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
 * The signed-in home. #784: the everyday shell is the live default for the current workspace — the everyday
 * flag is ON by default and, with no owner workspace pinned, it is a full rollout, so a signed-in member
 * lands on the redesigned shell. Setting VITE_EVERYDAY_SHELL=false (or pinning an owner workspace) restores
 * today's console for everyone else. Reads only the current workspace id; touches no backend/money/approval.
 */
function AuthedHome(): React.JSX.Element {
  const { identity } = useAppState();
  if (
    shouldShowEverydayShell({
      flagOn: EVERYDAY_SHELL_ENABLED,
      ownerWorkspaceId: EVERYDAY_SHELL_OWNER_WORKSPACE_ID,
      workspaceId: identity?.workspaceId,
    })
  ) {
    return <EverydayShell />;
  }
  return <Workspace />;
}

export function App(): React.JSX.Element {
  // useRoute keeps these top-level branches in sync with client navigation (and browser back/forward).
  const path = useRoute();
  const status = STATUS_PATH.exec(path);
  if (status) return <StatusPage slug={decodeURIComponent(status[1]!)} />;
  if (SUPPORT_STATUS_PATH.test(path)) return <SupportTicketStatus />;

  // #784: the onboarding experience is the default public landing at root `/` and `/welcome`. It renders
  // before the auth boundary (no session needed); "take me in" carries the visitor into the everyday shell.
  if (WELCOME_PATH.test(path) && shouldShowOnboardingV2({ flagOn: ONBOARDING_V2_ENABLED })) {
    return <OnboardingExperience onEnterApp={() => navigate("/everyday")} />;
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

  // The everyday-shell redesign (#784) also has its own explicit `/everyday` route; default-ON via the flag.
  if (EVERYDAY_SHELL_ENABLED && EVERYDAY_PATH.test(path)) {
    return (
      <AuthGate>
        <EverydayShell />
      </AuthGate>
    );
  }

  return (
    <AuthGate>
      <AuthedHome />
    </AuthGate>
  );
}
