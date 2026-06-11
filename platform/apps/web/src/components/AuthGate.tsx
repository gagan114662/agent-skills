/**
 * The top-level boundary: it bootstraps the session and decides which screen a visitor sees.
 *
 * Routing (#149): logged-in visitors get the app at any path; logged-out visitors get the public
 * marketing landing at `/`, and the sign-in / sign-up forms at `/login` and `/signup`. The landing is
 * code-split (lazy) so it never ships in the bundle a signed-in user downloads. Loading and API-offline
 * states keep their friendly house-voice screens.
 */
import { Suspense, lazy, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { BRAND, VOICE } from "../brand.js";
import { Link, useRoute } from "../routing.js";
import { Wordmark } from "./Wordmark.js";

type Mode = "login" | "signup";

// Code-split the marketing site: signed-in users never download it.
const Landing = lazy(() => import("./landing/Landing.js").then((m) => ({ default: m.Landing })));

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const store = useStore();
  const { phase } = useAppState();
  const path = useRoute();

  useEffect(() => {
    void store.bootstrap();
  }, [store]);

  if (phase === "ready") return <>{children}</>;
  if (phase === "loading") return <Splash />;
  if (phase === "offline") return <OfflineNotice onRetry={() => void store.bootstrap()} />;

  // Logged out: the public landing at "/", the auth forms at their own routes.
  if (path === "/login") return <AuthForm initialMode="login" />;
  if (path === "/signup") return <AuthForm initialMode="signup" />;
  return (
    <Suspense fallback={<Splash />}>
      <Landing />
    </Suspense>
  );
}

/** The brand splash, shown while the session bootstraps (and as the lazy-landing fallback). */
export function Splash(): React.JSX.Element {
  return (
    <div className="splash">
      <div className="splash__mark splash__mark--pop">{BRAND.mark}</div>
      <p>{VOICE.loading}</p>
    </div>
  );
}

/**
 * Shown when the API origin can't be reached (e.g. the console is hosted standalone with no backend
 * wired yet — #108). A clear, non-crashing state beats a blank page; "Retry" re-runs bootstrap once
 * the API is live.
 */
export function OfflineNotice({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div className="splash">
      <div className="splash__mark splash__mark--pop">{BRAND.mark}</div>
      <h1>{VOICE.offlineTitle}</h1>
      <p>{VOICE.offlineBody}</p>
      <button className="btn btn--primary" type="button" onClick={onRetry}>
        Try again
      </button>
      <p className="splash__signoff">{VOICE.signOff}</p>
    </div>
  );
}

export function AuthForm({ initialMode }: { initialMode: Mode }): React.JSX.Element {
  const store = useStore();
  // The route is the source of truth for which form shows; switching modes is a navigation.
  const mode = initialMode;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await store.login(email, password);
      } else {
        await store.signup({ email, password, displayName, workspaceSlug });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={onSubmit}>
        <Link href="/" className="auth__brand" aria-label={BRAND.name}>
          <Wordmark />
        </Link>
        <p className="auth__tag">{BRAND.tagline}</p>

        {mode === "signup" && (
          <label className="field">
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ada Lovelace"
              autoComplete="name"
            />
          </label>
        )}

        <label className="field">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </label>

        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>

        {mode === "signup" && (
          <label className="field">
            Workspace
            <input
              value={workspaceSlug}
              onChange={(e) => setWorkspaceSlug(e.target.value)}
              placeholder="acme"
            />
          </label>
        )}

        {error && <p className="auth__error">{error}</p>}

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {mode === "login" ? "Sign in" : "Create account"}
        </button>

        <p className="auth__switch">
          {mode === "login" ? (
            <>
              New here?{" "}
              <Link href="/signup" className="linklike">
                Create one
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link href="/login" className="linklike">
                Sign in instead
              </Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
