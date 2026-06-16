/**
 * The #260 non-technical onboarding screen: ONE screen, two things — type your domain, click "Sign in with
 * Google". Nothing else. No password, no workspace name, no token paste, no model picker. The Google button
 * is a full-page navigation to `/auth/google/start?domain=…` (not a fetch) so the OAuth redirect dance runs
 * in the browser; the server's callback creates the workspace, kicks Scout, and lands the user on the board.
 *
 * Every server-side failure redirects back here with `?error=<code>`, which we render in the house voice.
 */
import { useState, type FormEvent } from "react";
import { BRAND, ONBOARDING } from "../brand.js";
import { googleStartUrl } from "../api/client.js";
import { Wordmark } from "./Wordmark.js";
import { PopMark } from "./PopMark.js";

/** Read the `?error=<code>` the OAuth routes redirect with, mapped to a friendly line (or null). */
function errorFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const code = new URLSearchParams(window.location.search).get("error");
  if (!code) return null;
  const errors = ONBOARDING.errors as Record<string, string | undefined>;
  return errors[code] ?? ONBOARDING.errors.generic;
}

export function Onboarding(): React.JSX.Element {
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(errorFromUrl);
  const [busy, setBusy] = useState(false);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = domain.trim();
    if (!trimmed) {
      setError(ONBOARDING.needDomain);
      return;
    }
    setBusy(true);
    // Full-page navigation to the API's OAuth entry — the consent screen + callback take it from here.
    window.location.assign(googleStartUrl(trimmed));
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={onSubmit}>
        <PopMark burst className="auth__popmark" />
        <a href="/" className="auth__brand" aria-label={BRAND.name}>
          <Wordmark />
        </a>
        <h1 className="auth__tag">{ONBOARDING.title}</h1>
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

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {ONBOARDING.googleCta}
        </button>

        <p className="auth__switch">{ONBOARDING.reassurance}</p>
      </form>
    </div>
  );
}
