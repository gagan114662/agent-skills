/** App root: the auth boundary wrapping the workspace shell. */
import { useEffect } from "react";
import { AuthGate, Splash } from "./components/AuthGate.js";
import { StatusPage } from "./components/StatusPage.js";
import { SupportTicketStatus } from "./components/SupportTicketStatus.js";
import { PublicDogfood } from "./components/dogfood/PublicDogfood.js";
import { TheaterView } from "./components/theater/TheaterView.js";
import { DemoSandbox } from "./components/demo/DemoSandbox.js";
import { OnboardingExperience } from "./components/onboarding/OnboardingExperience.js";
import { LiveEverydayShell } from "./components/everyday/LiveEverydayShell.js";
import { EverydayShell } from "./components/everyday/EverydayShell.js";
import { ipopDogfoodEveryday } from "./components/everyday/everyday-data.js";
import { APP_ROUTES, navigate, useRoute } from "./routing.js";
import { useAppState, useStore } from "./store/StoreContext.js";

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
/** The #784 first-run onboarding experience — now the DEFAULT landing. Root `/` and `/welcome` both
 * open the Tomo-simple marketing door for everyone; the CTA carries signed-in members into `/everyday`. */
const WELCOME_PATH = /^\/(?:welcome\/?)?$/;
/** The everyday workspace shell (#784) — the linzumi-calm chat-first redesign, also reachable at its own
 * `/everyday` path. It is the live default for a signed-in workspace (see {@link AuthedHome}). */
const EVERYDAY_PATH = /^\/everyday\/?$/;
/** Auth forms are first-class public routes, not catch-all app shells (#1457/#1459). */
const LOGIN_PATH = /^\/login\/?$/;
const SIGNUP_PATH = /^\/signup\/?$/;
/** The one-icon dashboard from the homepage: a public summary of what the agent team has done. */
const DASHBOARD_PATH = /^\/dashboard\/?$/;

/**
 * The signed-in home. The iMessage/Codex room is the product now; do not let stale deployment flags
 * send signed-in users back to the legacy console.
 */
function AuthedHome(): React.JSX.Element {
  return <LiveEverydayShell />;
}

function DashboardRoute(): React.JSX.Element {
  const store = useStore();
  const { phase } = useAppState();

  useEffect(() => {
    void store.bootstrap();
  }, [store]);

  if (phase === "ready") return <LiveEverydayShell dashboardFirst dashboardOnly />;
  if (phase === "loading") return <Splash />;
  return <EverydayShell data={ipopDogfoodEveryday()} dashboardFirst dashboardOnly />;
}

function NotFoundRoute(): React.JSX.Element {
  return (
    <main className="splash" role="main" aria-labelledby="not-found-title">
      <p className="auth__trial-badge">404</p>
      <h1 id="not-found-title">Page not found</h1>
      <p>
        This link doesn't point to a live ipop page. Head back to the front door and start the
        marketing team from there.
      </p>
      <div className="auth__actions">
        <a className="btn btn--primary" href={APP_ROUTES.home}>
          Go home
        </a>
        <a className="btn" href="/start">
          Start
        </a>
      </div>
    </main>
  );
}

export function App(): React.JSX.Element {
  // useRoute keeps these top-level branches in sync with client navigation (and browser back/forward).
  const path = useRoute();
  const status = STATUS_PATH.exec(path);
  if (status) return <StatusPage slug={decodeURIComponent(status[1]!)} />;
  if (SUPPORT_STATUS_PATH.test(path)) return <SupportTicketStatus />;
  const dogfood = DOGFOOD_PATH.exec(path);
  if (dogfood) return <PublicDogfood slug={decodeURIComponent(dogfood[1] ?? "ipop")} />;

  // #784: root `/` and `/welcome` are the product front door for everyone. Signed-in members still need to
  // see the marketing-icon homepage; the CTA takes them into the everyday room.
  if (WELCOME_PATH.test(path)) {
    return <OnboardingExperience onEnterApp={() => navigate(APP_ROUTES.everyday)} />;
  }

  // The instant demo is fully public — no session, no auth — so it renders before the auth boundary.
  if (DEMO_PATH.test(path)) return <DemoSandbox />;

  if (LOGIN_PATH.test(path) || SIGNUP_PATH.test(path)) {
    return (
      <AuthGate>
        <AuthedHome />
      </AuthGate>
    );
  }

  // The homepage Dashboard icon should not dump visitors into the auth wall. Anonymous visitors get a
  // clearly-labelled sample; signed-in workspaces get the live workspace dashboard, not hard-coded dogfood.
  if (DASHBOARD_PATH.test(path)) return <DashboardRoute />;

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

  return <NotFoundRoute />;
}
