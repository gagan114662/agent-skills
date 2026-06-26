/**
 * The non-technical onboarding screen.
 *
 * #260 established the one-screen entry: type your domain, then sign in with Google. #633 makes it
 * OUTCOME-FIRST — the moment a visitor types their website and asks, we immediately produce a real,
 * personalized artifact about their business and stream it in live ({@link DeliverablePreview}), while the
 * Google sign-in / config runs alongside it, never as a gate. A brand-new visitor watches a deliverable
 * appear with zero required setup; they sign in when (and if) they like what they see.
 *
 * The Google path is still a full-page navigation to `/auth/google/start?domain=…` (not a fetch) so the
 * OAuth redirect dance runs in the browser; the server's callback creates the workspace, kicks Scout, and
 * lands the user on the board. Every server-side failure redirects back here with `?error=<code>`, which we
 * render in the house voice.
 */
import { useEffect, useState, type FormEvent } from "react";
import { BRAND, ONBOARDING } from "../brand.js";
import { api, googleStartUrl } from "../api/client.js";
import { trackAcquisitionEvent } from "../acquisition-events.js";
import { Link } from "../routing.js";
import { Wordmark } from "./Wordmark.js";
import { PopMark } from "./PopMark.js";
import { DeliverablePreview } from "./DeliverablePreview.js";
import { AcquisitionPipelinePreview } from "./acquisition/AcquisitionPipelinePreview.js";

/** Read the `?error=<code>` the OAuth routes redirect with. */
function errorCodeFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("error");
}

/** Map a redirected-back OAuth error code to a friendly line (or null). */
function errorFromUrl(): string | null {
  const code = errorCodeFromUrl();
  if (!code) return null;
  const errors = ONBOARDING.errors as Record<string, string | undefined>;
  return errors[code] ?? ONBOARDING.errors.generic;
}

export function Onboarding(): React.JSX.Element {
  const [domain, setDomain] = useState("");
  const [errorCode] = useState(errorCodeFromUrl);
  const [error, setError] = useState<string | null>(errorFromUrl);
  const [busy, setBusy] = useState(false);
  // #633: once a visitor submits a website we switch to the live deliverable view (config runs alongside,
  // not before). `null` = the entry form; a string = the URL we're streaming a deliverable for.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // #300: offer the low-commitment "explore a sample workspace" entry only when the deployment turned it on
  // (default OFF). We ask the server rather than assume, and a failure/offline just hides it — the Google
  // path is always available, so this can never block sign-in.
  const [sampleOffered, setSampleOffered] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .getSampleConsole()
      .then((res) => {
        if (live) setSampleOffered(res.offered);
      })
      .catch(() => {
        if (live) setSampleOffered(false);
      });
    return () => {
      live = false;
    };
  }, []);

  /** The trimmed domain, or null after nudging the visitor when it's blank. Shared by both actions. */
  function validatedDomain(): string | null {
    const trimmed = domain.trim();
    if (!trimmed) {
      setError(ONBOARDING.needDomain);
      return null;
    }
    setError(null);
    return trimmed;
  }

  // #633 OUTCOME FIRST: the primary action. Produce the deliverable immediately — no setup, no redirect.
  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = validatedDomain();
    if (trimmed) {
      trackAcquisitionEvent("activation-start", { url: trimmed, source: "start-domain-submit" });
      setPreviewUrl(trimmed);
    }
  }

  // The parallel config path: full-page navigation to the API's OAuth entry. Available on the entry screen
  // AND alongside the streaming deliverable — it is never the gate to seeing the outcome.
  async function signInWithGoogle(): Promise<void> {
    const trimmed = validatedDomain();
    if (!trimmed) return;
    trackAcquisitionEvent("activation-start", { url: trimmed, source: "start-google" });
    setBusy(true);
    try {
      const status = await api.getGoogleAuthStatus();
      if (!status.configured) {
        setError(status.message);
        setBusy(false);
        return;
      }
      window.location.assign(googleStartUrl(trimmed));
    } catch {
      setError(ONBOARDING.errors.google_unavailable);
      setBusy(false);
    }
  }

  // #633: once a website is submitted, the live deliverable IS the screen — config sits beside it.
  if (previewUrl) {
    return (
      <div className="auth auth--pipeline">
        <div className="auth__pipeline">
          <AcquisitionPipelinePreview domain={previewUrl} icp="" />
          <DeliverablePreview
            url={previewUrl}
            onSignIn={signInWithGoogle}
            onRestart={() => {
              setPreviewUrl(null);
              setBusy(false);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={onSubmit}>
        <PopMark burst className="auth__popmark" />
        <a href="/" className="auth__brand" aria-label={BRAND.name}>
          <Wordmark />
        </a>
        <h1 className="auth__headline">{ONBOARDING.title}</h1>
        <p className="auth__tag">{ONBOARDING.sub}</p>

        <label className="field">
          {ONBOARDING.domainLabel}
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={ONBOARDING.domainPlaceholder}
            autoComplete="url"
            inputMode="url"
            autoFocus
          />
        </label>

        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}

        {/* Outcome first: the primary button produces the deliverable. */}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {ONBOARDING.deliverable.cta}
        </button>

        {/* Config in parallel: sign-in stays one click away, but it is not the gate to the outcome. */}
        <button className="btn btn--ghost" type="button" onClick={signInWithGoogle} disabled={busy}>
          {ONBOARDING.googleCta}
        </button>

        {sampleOffered && (
          <p className="auth__alt">
            {ONBOARDING.sampleDivider}{" "}
            <Link href="/sample" className="linklike">
              {ONBOARDING.sampleCta}
            </Link>
          </p>
        )}

        {errorCode === "google_unavailable" && (
          <p className="auth__alt">
            {ONBOARDING.fallbackSignup.lead}{" "}
            <Link href="/signup" className="linklike">
              {ONBOARDING.fallbackSignup.cta}
            </Link>
          </p>
        )}

        <p className="auth__switch">{ONBOARDING.reassurance}</p>
      </form>
    </div>
  );
}
