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
import { BRAND, LANDING, PRICING, VOICE } from "../brand.js";
import { Link, replace, useRoute } from "../routing.js";
import { Wordmark } from "./Wordmark.js";
import { PopMark } from "./PopMark.js";
import { Onboarding } from "./Onboarding.js";
import { SampleConsole } from "./SampleConsole.js";
import { isMarketingPath } from "./site/paths.js";

type Mode = "login" | "signup";
type AuthError =
  | { kind: "plain"; message: string }
  | { kind: "email-taken"; message: string }
  | { kind: "slug-taken"; message: string; suggestion: string };

// Code-split the marketing site: signed-in users never download it.
const Landing = lazy(() => import("./landing/Landing.js").then((m) => ({ default: m.Landing })));
// #214: the dedicated public pricing page. Its own lazy chunk; public at every phase like the landing.
const PricingPage = lazy(() =>
  import("./landing/PricingPage.js").then((m) => ({ default: m.PricingPage })),
);

/** Where the post-signup activation/first-run picks up a plan the visitor chose on `/pricing` (#214). */
const PLAN_INTENT_KEY = "plan-intent";
const PASSWORD_MIN_LENGTH = 8;
const DISPLAY_NAME_MIN_LENGTH = 2;
const WORKSPACE_SLUG_MIN_LENGTH = 2;
const WORKSPACE_SLUG_PATTERN = "[a-z0-9][a-z0-9-]{1,62}";

function workspaceSlugFrom(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-")
      .slice(0, 50) || "workspace"
  );
}

function suggestedWorkspaceSlug(raw: string): string {
  return `${workspaceSlugFrom(raw)}-2`;
}

function authErrorFor(err: unknown, mode: Mode, workspaceSlug: string): AuthError {
  const message = err instanceof Error ? err.message : "Something went wrong";
  const lower = message.toLowerCase();
  if (
    mode === "signup" &&
    lower.includes("email") &&
    (lower.includes("use") || lower.includes("taken"))
  ) {
    return { kind: "email-taken", message: "That email already has an account." };
  }
  if (mode === "signup" && lower.includes("slug")) {
    return {
      kind: "slug-taken",
      message: "That workspace URL is already taken.",
      suggestion: suggestedWorkspaceSlug(workspaceSlug),
    };
  }
  if (
    lower.includes("password") &&
    (lower.includes("minimum") || lower.includes("least") || lower.includes("short"))
  ) {
    return {
      kind: "plain",
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }
  return { kind: "plain", message };
}

/** Read a `?plan=<key>` hint off the URL and resolve it to a known plan teaser (or null). */
function intendedPlanFromUrl(): (typeof LANDING.plans)[number] | null {
  const key = new URLSearchParams(window.location.search).get("plan");
  return key ? (LANDING.plans.find((p) => p.key === key) ?? null) : null;
}
// #151: the public trust page. Code-split + reachable at any phase (logged-in or out).
const Security = lazy(() => import("./landing/Security.js").then((m) => ({ default: m.Security })));
// The marketing-site machine (#153): compare / stories / guides / changelog / brand. Its own lazy chunk.
const MarketingSite = lazy(() => import("./site/MarketingSite.js"));
// #252: the prerendered, indexable blog. Public at every phase like the landing; its own lazy chunk.
const Blog = lazy(() => import("../blog/Blog.js"));

/** True for `/blog` and any `/blog/<slug>` post (the public, prerendered blog — #252). */
function isBlogPath(path: string): boolean {
  return path === "/blog" || path.startsWith("/blog/");
}

/** The query key carrying where a logged-out deep link wanted to land, set on the `/start` redirect. */
const RETURN_KEY = "return";

/**
 * A safe same-origin return path, or null. Only a single leading slash is allowed, so a crafted
 * `?return=//evil.com` or `?return=https://evil.com` can never turn into an open redirect off-site
 * (#200 premortem) — we follow internal app paths only.
 */
function safeReturnPath(raw: string | null): string | null {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
}

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const store = useStore();
  const { phase } = useAppState();
  const path = useRoute();

  useEffect(() => {
    void store.bootstrap();
  }, [store]);

  // #304: once signed in, honour the `?return=<path>` set when a logged-out visitor deep-linked into
  // an app route — land them on the page they originally wanted, not the generic app root. We REPLACE
  // (not push) so the `/start?return=…` entry leaves the back-stack: otherwise Back lands on it and this
  // very effect re-fires, shoving the visitor forward again — an inescapable back-button trap.
  useEffect(() => {
    if (phase !== "ready" || typeof window === "undefined") return;
    const ret = safeReturnPath(new URLSearchParams(window.location.search).get(RETURN_KEY));
    if (ret) replace(ret);
  }, [phase]);

  // #151: the trust page is public and works at every phase (before login, while loading, after login),
  // so it is checked ahead of the phase gates — a logged-in user can open it from the footer too.
  if (path === "/security") {
    return (
      <Suspense fallback={<Splash />}>
        <Security />
      </Suspense>
    );
  }

  // #153 The public marketing site renders for everyone (anon AND signed-in), matched before the phase
  // checks — it fetches its own published content and degrades gracefully, so it works even while the
  // session is still bootstrapping or the API is offline.
  if (isMarketingPath(path)) {
    return (
      <Suspense fallback={<Splash />}>
        <MarketingSite />
      </Suspense>
    );
  }

  // #252: the public blog is prerendered to static HTML for crawlers and reachable at every phase
  // (anon, loading, signed-in) — matched before the phase gates so a shared post link never falls
  // through to the landing, and so the client takes over cleanly from the prerendered HTML.
  if (isBlogPath(path)) {
    return (
      <Suspense fallback={<Splash />}>
        <Blog />
      </Suspense>
    );
  }

  // #300: the read-only sample workspace is a public, low-commitment front door — reachable at every phase
  // (a prospect evaluating before signing up), matched before the phase gates so it never falls through to
  // the landing and never requires a session. It degrades honestly when the deployment flag is OFF.
  if (path === "/sample") return <SampleConsole />;

  // #214: the public pricing page is reachable at every phase (a price-shopping visitor, a shared link,
  // an ad destination) — matched before the phase gates so it never falls through to the full landing.
  if (path === "/pricing") {
    return (
      <Suspense fallback={<Splash />}>
        <PricingPage />
      </Suspense>
    );
  }

  if (phase === "ready") return <>{children}</>;
  if (phase === "loading") return <Splash />;
  if (phase === "offline") return <OfflineNotice onRetry={() => void store.bootstrap()} />;

  // Logged out: the public landing at "/", the auth forms at their own routes.
  // #260: the non-technical onboarding entry — enter your domain, Sign in with Google. The OAuth callback
  // also redirects failures back here (`/start?error=…`), so an un-authed visitor always sees this screen.
  if (path === "/start") return <Onboarding />;
  if (path === "/login") return <AuthForm initialMode="login" />;
  if (path === "/signup") return <AuthForm initialMode="signup" />;
  // The marketing landing lives at `/` only. Every other path is a deep link into the authed app
  // (e.g. a bookmarked `/app/...`), so a logged-out hit must route to sign-in rather than silently
  // serving the marketing page (#304) — preserving the destination so we can land them there after.
  if (path !== "/") return <RedirectToSignIn from={requestedPath()} />;
  return (
    <Suspense fallback={<Splash />}>
      <Landing />
    </Suspense>
  );
}

/** The full path the visitor asked for — pathname + query + hash — so the return is faithful. */
function requestedPath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search + window.location.hash;
}

/**
 * A logged-out visitor hit an app route. Send them to the `/start` sign-in screen, preserving where
 * they were headed in `?return=` (#304). The navigation runs in an effect (never during render); a
 * brand splash covers the brief moment before the route changes. We REPLACE the app-route entry rather
 * than pushing, so the unauthorized URL never enters the back-stack for the visitor to bounce off of.
 */
function RedirectToSignIn({ from }: { from: string }): React.JSX.Element {
  useEffect(() => {
    replace(`/start?${RETURN_KEY}=${encodeURIComponent(from)}`);
  }, [from]);
  return <Splash />;
}

/** The brand splash, shown while the session bootstraps (and as the lazy-landing fallback). */
export function Splash(): React.JSX.Element {
  return (
    <div className="splash">
      <PopMark burst />
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
      <PopMark />
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
  const [error, setError] = useState<AuthError | null>(null);
  const [busy, setBusy] = useState(false);
  // #214: a plan chosen on `/pricing` arrives as `?plan=<key>`. We frame it as a free trial here and
  // hand it off (sessionStorage seam) for the post-signup activation/first-run to pick up — we don't
  // change signup itself, so the billing/activation work owns what happens with the chosen plan.
  const [intendedPlan] = useState(() => (initialMode === "signup" ? intendedPlanFromUrl() : null));

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (mode === "signup" && password.length < PASSWORD_MIN_LENGTH) {
      setError({
        kind: "plain",
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
      });
      setBusy(false);
      return;
    }
    try {
      if (mode === "login") {
        await store.login(email, password);
      } else {
        if (intendedPlan) {
          try {
            window.sessionStorage.setItem(PLAN_INTENT_KEY, intendedPlan.key);
          } catch {
            // sessionStorage can throw in private mode — the plan hint is a nicety, not load-bearing.
          }
        }
        const trimmedSlug = workspaceSlug.trim();
        await store.signup({
          email,
          password,
          displayName,
          ...(trimmedSlug ? { workspaceSlug: trimmedSlug } : {}),
        });
      }
    } catch (err) {
      setError(authErrorFor(err, mode, workspaceSlug));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={onSubmit}>
        <PopMark burst className="auth__popmark" />
        <Link href="/" className="auth__brand" aria-label={BRAND.name}>
          <Wordmark />
        </Link>
        <p className="auth__tag">{BRAND.tagline}</p>

        {mode === "signup" && (
          <p className="auth__trial" role="note">
            <span className="auth__trial-badge">{PRICING.trial.eyebrow}</span>{" "}
            {intendedPlan ? PRICING.trial.onPlan(intendedPlan.name) : PRICING.trial.generic}
          </p>
        )}

        {mode === "signup" && (
          <label className="field">
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ada Lovelace"
              autoComplete="name"
              required
              aria-required="true"
              minLength={DISPLAY_NAME_MIN_LENGTH}
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
            required
            aria-required="true"
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
            required
            aria-required="true"
            minLength={mode === "signup" ? PASSWORD_MIN_LENGTH : undefined}
          />
        </label>

        {mode === "signup" && (
          <label className="field">
            Workspace
            <input
              value={workspaceSlug}
              onChange={(e) => setWorkspaceSlug(e.target.value)}
              placeholder={workspaceSlugFrom(displayName || email.split("@")[0] || "workspace")}
              minLength={WORKSPACE_SLUG_MIN_LENGTH}
              pattern={WORKSPACE_SLUG_PATTERN}
              title="Optional. Use lowercase letters, numbers, and hyphens."
            />
          </label>
        )}

        {error && (
          <p className="auth__error" role="alert">
            {VOICE.authError} {error.message}{" "}
            {error.kind === "email-taken" && (
              <Link href="/login" className="linklike">
                Sign in instead
              </Link>
            )}
            {error.kind === "slug-taken" && <span>Try {error.suggestion}.</span>}
          </p>
        )}

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
