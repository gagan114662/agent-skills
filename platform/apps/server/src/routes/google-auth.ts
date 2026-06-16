import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { generateSessionToken } from "../auth/secrets.js";
import { SESSION_COOKIE } from "../auth/middleware.js";
import {
  findUserByEmail,
  createOAuthHumanAccount,
  getHumanMember,
  createSession,
} from "../db/repositories/auth.js";
import { getWorkspaceBySlug, createWorkspace } from "../db/repositories/workspaces.js";
import { setServiceCredentials } from "../db/repositories/external-credentials.js";
import { getWorkspaceOnboarding } from "../db/repositories/workspace-onboarding.js";
import { normalizeDomain } from "../auth/onboarding-domain.js";
import { signState, verifyState, newStateNonce, loadStateSecret } from "../auth/oauth-state.js";
import {
  loadGoogleOAuthConfig,
  buildGoogleAuthorizeUrl,
  googleConnectionSecrets,
  GOOGLE_CONNECTION_SERVICE_KEY,
  GOOGLE_CONNECTION_CAPABILITIES,
  type GoogleOAuthConfig,
} from "../auth/google-oauth.js";
import { createGoogleOAuthClient, type GoogleOAuthClient } from "../auth/google-client.js";
import type { SessionManager } from "../runtime/manager.js";
import { makeDefaultOnboardingBootstrap } from "../auth/onboarding-bootstrap-default.js";
import type { OnboardingBootstrapInput } from "../auth/onboarding-bootstrap.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days, matching the email/password flow

/** Where the web onboarding screen lives — every failure redirects back here with an `?error=` code. */
export const ONBOARDING_PATH = "/start";
/** Where a freshly-signed-in user lands: the working board. */
const BOARD_PATH = "/";

function setSessionCookie(reply: FastifyReply, raw: string): void {
  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export interface GoogleAuthRoutesOptions {
  /** Used to build the default post-signin bootstrap (seed fleet + Scout brief). */
  sessionManager?: SessionManager;
  /**
   * The Google app config. `undefined` ⇒ read from env live; explicit `null` ⇒ force "not configured"
   * (the routes redirect with `google_unavailable`). Tests pass a literal config.
   */
  config?: GoogleOAuthConfig | null;
  /** Inject a fake Google client in tests (no network). Default builds the real fetch client from config. */
  client?: GoogleOAuthClient;
  /** Inject a recording bootstrap in tests. Default seeds + briefs Scout over the SessionManager. */
  bootstrap?: (input: OnboardingBootstrapInput) => Promise<void>;
  /** Override the state-signing secret (tests). Default reads it live from env. */
  stateSecret?: string;
  /** Injectable clock for deterministic state expiry (tests). */
  now?: () => number;
}

/**
 * The #260 non-technical onboarding back end: ONE screen ("enter your domain → Sign in with Google") and
 * ONE Google consent covering identity + Search Console + Analytics. No token paste, no DNS, no model setup.
 *
 *  - `GET /auth/google/start?domain=<domain>` validates the typed domain, signs it into the OAuth `state`
 *    (CSRF + carrier — no server-side session table), and redirects to Google's consent screen.
 *  - `GET /auth/google/callback` verifies the state, exchanges the code, reads the verified identity,
 *    creates/attaches the workspace + a passwordless human, seals the Google tokens into the encrypted
 *    per-workspace connection (#192 vault, service_key `google` — the SAME key the #258 connection model
 *    reads), sets the `rid` session cookie, kicks the post-signin bootstrap (seed fleet + Scout verifies the
 *    domain & submits the sitemap), and lands the user on the board.
 *
 * Connecting is one-time CONSENT, not money — so no #13 gate (consistent with #243 money-only). Every
 * failure path redirects back to the onboarding screen with a friendly `?error=` code rather than a raw 500.
 */
export async function googleAuthRoutes(
  app: FastifyInstance,
  opts: GoogleAuthRoutesOptions = {},
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const bootstrap =
    opts.bootstrap ??
    (opts.sessionManager
      ? makeDefaultOnboardingBootstrap(opts.sessionManager, app.log)
      : async () => {});

  function resolveConfig(): GoogleOAuthConfig | null {
    return opts.config !== undefined ? opts.config : loadGoogleOAuthConfig();
  }
  function resolveClient(config: GoogleOAuthConfig): GoogleOAuthClient {
    return opts.client ?? createGoogleOAuthClient(config);
  }
  function stateSecret(): string {
    return opts.stateSecret ?? loadStateSecret();
  }
  function redirectError(reply: FastifyReply, code: string): FastifyReply {
    return reply.redirect(`${ONBOARDING_PATH}?error=${encodeURIComponent(code)}`);
  }

  /** A workspace slug derived from the domain, suffixed if already taken (new customers only). */
  async function uniqueSlug(base: string): Promise<string> {
    if (!(await getWorkspaceBySlug(base))) return base;
    for (let i = 0; i < 5; i += 1) {
      const candidate = `${base}-${randomBytes(3).toString("hex")}`;
      if (!(await getWorkspaceBySlug(candidate))) return candidate;
    }
    // Extremely unlikely; fall back to a fully random slug so signup never dead-ends.
    return `${base}-${randomBytes(8).toString("hex")}`;
  }

  // Step 1 — begin the single Google consent for the typed domain.
  app.get("/auth/google/start", async (req, reply) => {
    const config = resolveConfig();
    if (!config) return redirectError(reply, "google_unavailable");
    const domainParam = (req.query as { domain?: unknown }).domain;
    const result = normalizeDomain(typeof domainParam === "string" ? domainParam : "");
    if (!result.ok) return redirectError(reply, "invalid_domain");
    const state = signState({ domain: result.domain, nonce: newStateNonce() }, stateSecret(), now());
    return reply.redirect(buildGoogleAuthorizeUrl({ config, state }));
  });

  // Step 2 — Google redirects back here with the code; finish sign-in + bootstrap.
  app.get("/auth/google/callback", async (req, reply) => {
    const config = resolveConfig();
    if (!config) return redirectError(reply, "google_unavailable");
    const q = req.query as { code?: unknown; state?: unknown; error?: unknown };
    if (typeof q.error === "string" && q.error) return redirectError(reply, "google_denied");
    if (typeof q.code !== "string" || typeof q.state !== "string") {
      return redirectError(reply, "bad_request");
    }
    const payload = verifyState(q.state, stateSecret(), { now: now() });
    if (!payload) return redirectError(reply, "bad_state");
    const domain = normalizeDomain(payload.domain);
    if (!domain.ok) return redirectError(reply, "invalid_domain");

    // Exchange the code + read the verified identity (friendly redirect on any Google-side failure).
    let userId: string;
    let memberId: string;
    let workspaceId: string;
    let tokens;
    let user;
    try {
      tokens = await resolveClient(config).exchangeCode({ code: q.code });
      user = await resolveClient(config).fetchUserInfo(tokens.accessToken);
    } catch (err) {
      app.log.error({ err }, "google sign-in exchange failed");
      return redirectError(reply, "google_failed");
    }
    if (!user.emailVerified) return redirectError(reply, "email_unverified");

    // Create or attach the account. A returning Google user (matched by verified email) re-enters their
    // existing workspace; a brand-new user gets a fresh workspace named after their domain.
    const existing = await findUserByEmail(user.email);
    if (existing) {
      const member = await getHumanMember(existing.id);
      if (!member) return redirectError(reply, "no_workspace");
      userId = existing.id;
      memberId = member.id;
      workspaceId = member.workspaceId;
    } else {
      const ws = await createWorkspace({
        slug: await uniqueSlug(domain.slug),
        name: domain.domain,
      });
      const created = await createOAuthHumanAccount({
        workspaceId: ws.id,
        email: user.email,
        displayName: user.name && user.name.trim().length > 0 ? user.name : user.email,
      });
      userId = created.userId;
      memberId = created.memberId;
      workspaceId = ws.id;
    }

    // Seal the Google tokens into the encrypted per-workspace connection (#192 vault, service_key `google`).
    // This is the connection the GSC/Analytics connector (#258) reads — the live flow and the model reconcile.
    await setServiceCredentials({
      workspaceId,
      serviceKey: GOOGLE_CONNECTION_SERVICE_KEY,
      secrets: googleConnectionSecrets(tokens, { sub: user.sub, email: user.email }, now()),
      scopes: [...GOOGLE_CONNECTION_CAPABILITIES],
      connectedByMemberId: memberId,
    });

    // Sign the user in (the `rid` session cookie the rest of the app already understands).
    const { raw, hash } = generateSessionToken();
    await createSession({ userId, tokenHash: hash, expiresAt: new Date(now() + SESSION_TTL_MS) });
    setSessionCookie(reply, raw);

    // Post-signin bootstrap once per workspace: seed the fleet + kick Scout to verify the domain & submit
    // the sitemap. Best-effort and never re-fired on a later login (the bootstrap marks the workspace done).
    const onboarding = await getWorkspaceOnboarding(workspaceId);
    if (!onboarding?.bootstrapped) {
      await bootstrap({ workspaceId, memberId, domain: domain.domain, siteUrl: domain.url }).catch(
        (err: unknown) => app.log.error({ err }, "onboarding bootstrap failed"),
      );
    }

    return reply.redirect(BOARD_PATH);
  });
}
