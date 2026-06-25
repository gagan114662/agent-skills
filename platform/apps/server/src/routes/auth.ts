import type { FastifyInstance, FastifyReply } from "fastify";
import { hashPassword, verifyPassword, generateSessionToken, hashToken } from "../auth/secrets.js";
import { SESSION_COOKIE } from "../auth/middleware.js";
import {
  findUserByEmail,
  createHumanAccount,
  createSession,
  deleteSession,
} from "../db/repositories/auth.js";
import { getWorkspaceBySlug, createWorkspace } from "../db/repositories/workspaces.js";
import { parseEnvOrigins } from "../http/cors.js";
import {
  AUTH_PUBLIC_RATE_LIMIT,
  SIGNUP_PUBLIC_RATE_LIMIT,
  publicRateLimitPreHandler,
} from "../http/rate-limit.js";
import { readSignupAttribution, type SignupAttribution } from "../attribution/signup.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MIN_PASSWORD_LENGTH = 2;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function slugifyWorkspace(raw: string): string {
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

async function uniqueWorkspaceSlug(seed: string): Promise<string> {
  const base = slugifyWorkspace(seed);
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await getWorkspaceBySlug(slug))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * #418 — Decide the `SameSite`/`Secure` attributes for the `rid` session cookie based on the
 * deployment shape. In the split deploy (#108) the web console (https://ipop.ai) bootstraps by
 * calling GET /me on a *different origin* (https://api.ipop.ai); that is a cross-site credentialed
 * fetch, and the browser only attaches the cookie when it was set `SameSite=None; Secure`. A `Lax`
 * cookie is silently dropped on cross-site XHR/fetch, so bootstrap() 401s and AuthGate redirects
 * to /start. Cross-site presence is signalled by RELOAD_WEB_ORIGIN naming a separate web origin
 * (the same signal CORS keys off). `None` is invalid without `Secure`, so we force Secure whenever
 * we go cross-site. Same-origin / local dev keeps the original `Lax` + NODE_ENV-gated Secure so the
 * cookie still sets over plain http during development.
 */
export function resolveSessionCookieOptions(env: NodeJS.ProcessEnv = process.env): {
  sameSite: "none" | "lax";
  secure: boolean;
} {
  const crossSite = parseEnvOrigins(env).length > 0;
  if (crossSite) return { sameSite: "none", secure: true };
  return { sameSite: "lax", secure: env.NODE_ENV === "production" };
}

function setSessionCookie(reply: FastifyReply, raw: string): void {
  const { sameSite, secure } = resolveSessionCookieOptions();
  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite,
    path: "/",
    secure,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export interface AuthRoutesOptions {
  /**
   * Best-effort hook fired after a new workspace + owner are created (#123 seed-on-signup). It must
   * not throw — a failure here never fails the signup that already succeeded.
   */
  onWorkspaceCreated?: (
    workspaceId: string,
    ownerMemberId: string,
    attribution: SignupAttribution,
  ) => Promise<void>;
}

export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions = {},
): Promise<void> {
  const loginRateLimit = publicRateLimitPreHandler(AUTH_PUBLIC_RATE_LIMIT);
  const signupRateLimit = publicRateLimitPreHandler(SIGNUP_PUBLIC_RATE_LIMIT);

  app.post("/auth/signup", { preHandler: signupRateLimit }, async (req, reply) => {
    const b = req.body as {
      email?: string;
      password?: string;
      displayName?: string;
      workspaceSlug?: string;
      source?: string;
      utmSource?: string;
      utm_source?: string;
      utmMedium?: string;
      utm_medium?: string;
      utmCampaign?: string;
      utm_campaign?: string;
      trackingRef?: string;
      ref?: string;
    };
    const attribution = readSignupAttribution({
      body: b as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
    });
    if (!b.email || !b.password || !b.displayName) {
      return reply.code(400).send({ error: "email, password, displayName required" });
    }
    const email = normalizeEmail(b.email);
    if (!EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: "valid email required" });
    }
    if (b.password.length < MIN_PASSWORD_LENGTH) {
      return reply
        .code(400)
        .send({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (await findUserByEmail(email)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const requestedSlug = b.workspaceSlug?.trim();
    if (requestedSlug && !SLUG_RE.test(requestedSlug)) {
      return reply
        .code(400)
        .send({ error: "workspace slug must use lowercase letters, numbers, and hyphens" });
    }
    const workspaceSlug =
      requestedSlug ||
      (await uniqueWorkspaceSlug(b.displayName || email.split("@")[0] || "workspace"));
    const ws =
      (await getWorkspaceBySlug(workspaceSlug)) ??
      (await createWorkspace({ slug: workspaceSlug, name: workspaceSlug }));
    const { userId, memberId } = await createHumanAccount({
      workspaceId: ws.id,
      email,
      passwordHash: await hashPassword(b.password),
      displayName: b.displayName,
    });
    const { raw, hash } = generateSessionToken();
    await createSession({
      userId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    setSessionCookie(reply, raw);
    // #123/#902: seed the department fleet so the owner lands inside a working agency. Best-effort —
    // the hook never throws, so signup can't be broken.
    if (opts.onWorkspaceCreated) await opts.onWorkspaceCreated(ws.id, memberId, attribution);
    return reply.code(201).send({ ok: true });
  });

  app.post("/auth/login", { preHandler: loginRateLimit }, async (req, reply) => {
    const b = req.body as { email?: string; password?: string };
    const user = await findUserByEmail(normalizeEmail(b.email ?? ""));
    if (
      !user ||
      !user.passwordHash ||
      !(await verifyPassword(b.password ?? "", user.passwordHash))
    ) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const { raw, hash } = generateSessionToken();
    await createSession({
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    setSessionCookie(reply, raw);
    return { ok: true };
  });

  app.post("/auth/logout", async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) await deleteSession(hashToken(cookie));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
