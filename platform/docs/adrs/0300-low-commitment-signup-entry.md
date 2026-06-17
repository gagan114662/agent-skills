# ADR-0300: Low-commitment signup entry — sample workspace + progressive Google scopes

- **Status:** Accepted (shipped in PR for #300)
- **Date:** 2026-06-17
- **Context issue:** [#300](https://github.com/gagan114662/agent-skills/issues/300) — `/start`'s only path
  is "Sign in with Google", and that single consent grants Search Console + Analytics up front (#260). For a
  prospect who doesn't use Google, won't grant data scopes just to evaluate, or simply wants to look around,
  a broad-scope OAuth wall is the highest-friction possible first step — it kills the aha. Acceptance: a new
  user can reach a working **sample** console and see at least one **real agent deliverable** WITHOUT
  granting any Google data scope; `/start` offers at least one non-Google entry; and the GSC/Analytics
  consent is requested only when SEO work is actually initiated.
- **Money-only gate:** [ADR-0243](0243-money-only-approval.md) — exploring a read-only sample and granting
  identity-only consent are not money, so they carry no #13 approval.
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — see "Honoring #200" below.
- **Builds on:** the #260 Google OAuth scaffolding (`auth/google-oauth.ts` scope set, `auth/oauth-state.ts`
  HMAC state, the env-config loader, `onboarding-bootstrap`), and [ADR-0258](0258-connect-once-integrations.md)
  (the `service_key="google"` connection the callback seals into). This issue is the **front-door signup**
  experience and is distinct from #258 / #262 (agent-side real-world integrations).

## Decision

Lower the cost of the first step without inventing parallel auth. Two front-door alternatives, both **default
OFF** behind one new `signupEntry` config block, reusing the existing #260 seams:

1. **A read-only sample workspace** (`signupEntry.sampleWorkspace`, default OFF):
   - A pure builder `onboarding/signup-entry.ts` → `buildSampleConsole()` returns a static, deterministic
     payload carrying at least one **representative real Scout SEO deliverable**. It is input-free, so it is
     injection-safe by construction (#200 §6) and creates no workspace, session, or row (#200 §4).
   - An **unauthenticated, read-only** route `GET /sample/console` answers `{ offered, console }`. With the
     flag OFF it honestly answers `{ offered: false }` — never a faked demo (#200 §3).
   - The web mounts a `/sample` page (public, before the AuthGate phase gates) and `/start` shows an
     "Explore a sample workspace" link **only when the server reports it offered** — so the non-Google entry
     appears exactly when the deployment has enabled it, and the Google path is always available regardless.
   - Result: a prospect sees a real deliverable with **no account and no Google data scope** (#300 AC1/AC2).

2. **Progressive Google scopes** (`signupEntry.progressiveScopes`, default OFF):
   - Pure `resolveOnboardingScopes({ progressive, intent })` in `auth/google-oauth.ts`: with progressive OFF
     every consent requests the full set (today's #260 single consent, byte-for-byte); with it ON, the
     **signup** step requests **identity only** and the **seo** step requests the full GSC + Analytics set.
   - The intent rides in the HMAC `state` (`auth/oauth-state.ts` gains an optional `intent`, omitted from the
     signed body for a signup state so a #260 state is byte-for-byte unchanged and round-trips to exactly
     `{ domain, nonce }`). The callback records the **capabilities matching what was requested**
     (`capabilitiesForScopes`) — so a deferred workspace honestly shows it has not yet granted GSC/Analytics.
   - `GET /auth/google/start?intent=seo` is the deferred grant the app navigates to when SEO work is
     initiated (a returning user matched by verified email re-enters their existing workspace and the
     connection is upgraded). Consent for the broad data scopes is therefore requested **only at the point
     SEO work begins**, not at signup (#300 AC3).

### Why a sample workspace, not magic-link, as the headline

A magic-link entry requires sending email — an external credential and a live, irreversible action, both
explicitly out of scope for this change ("no credentials, nothing live"). A read-only sample is fully
self-contained, reversible by construction, and directly satisfies "see a real deliverable before
committing." The issue asks for magic-link **or** a sample workspace; we ship the sample.

### Why a deployment flag, not per-workspace owner-first

The owner-workspace-first rollout pattern (e.g. `connectClaude`, `agentRegistry`) gates a per-workspace
feature. These are **anonymous front-door** features — at `/start` no workspace exists yet — so per-workspace
gating is not meaningful. The deployment flag *is* the owner-first control: the owner turns it on for their
own deployment first. Both flags still default OFF, so a deployment that sets nothing keeps today's #260
behavior exactly.

## Honoring #200 (premortem)

- **§3 production-grounded / honest degrade:** every flag OFF ⇒ today's #260 behavior; the sample route
  answers `{ offered: false }` rather than faking a demo; the web hides the entry when not offered.
- **§4 reversibility:** the sample console is read-only — no workspace, session, row, or real-world action,
  so there is nothing to undo. Identity-only signup is the *narrower* grant; the broad data scopes are
  deferred, shrinking the up-front blast radius.
- **§6 injection defense:** `buildSampleConsole()` takes no input (static constant). The OAuth `intent` is
  validated to the closed set `{signup, seo}` and rides inside the HMAC-signed `state`, so a poisoned
  callback can neither widen scopes nor steer what the sample renders.

## Alternatives considered

- **Email magic-link** — rejected for this PR: requires an email credential + a live send (out of scope).
- **Always-show the sample link, gate only the page** — rejected: a dead link when the flag is off reads as
  broken; asking the server keeps the front door honest.
- **Deriving recorded capabilities from the returned token `scope`** — rejected: the #260 integration test
  proves capabilities are recorded from the *requested* grant, not the token echo; deriving from the request
  keeps that contract and avoids depending on provider-specific scope echoing.

## Consequences

- New `signupEntry` config block (`RELOAD_SIGNUP_SAMPLE_WORKSPACE`, `RELOAD_SIGNUP_PROGRESSIVE_SCOPES`),
  default OFF; managed layer is the lock.
- New pure module + route + web page, all flag-gated; the #260 Google flow is unchanged when both flags are
  off. Follow-up: a dedicated in-app "Connect Google for SEO" affordance that calls `?intent=seo` at the
  moment Scout is briefed for SEO work (the server seam already supports it).
