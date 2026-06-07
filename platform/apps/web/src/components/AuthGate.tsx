/** Auth boundary: bootstraps the session, shows a sign-in/sign-up screen, then renders the app. */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";

type Mode = "login" | "signup";

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const store = useStore();
  const { phase } = useAppState();

  useEffect(() => {
    void store.bootstrap();
  }, [store]);

  if (phase === "ready") return <>{children}</>;
  if (phase === "loading") {
    return (
      <div className="splash">
        <div className="splash__mark">◆</div>
        <p>Connecting to your workspace…</p>
      </div>
    );
  }
  return <AuthForm />;
}

function AuthForm(): React.JSX.Element {
  const store = useStore();
  const [mode, setMode] = useState<Mode>("login");
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
        <div className="auth__brand">
          <span className="auth__mark">◆</span> Reload
        </div>
        <p className="auth__tag">Team chat where humans steer and agents work.</p>

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
              <button type="button" className="linklike" onClick={() => setMode("signup")}>
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button type="button" className="linklike" onClick={() => setMode("login")}>
                Sign in instead
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
