import type { FastifyInstance, FastifyReply } from "fastify";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
} from "../auth/secrets.js";
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

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

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
  onWorkspaceCreated?: (workspaceId: string, ownerMemberId: string) => Promise<void>;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions = {}): Promise<void> {
  const loginRateLimit = publicRateLimitPreHandler(AUTH_PUBLIC_RATE_LIMIT);
  const signupRateLimit = publicRateLimitPreHandler(SIGNUP_PUBLIC_RATE_LIMIT);

  app.post("/auth/signup", { preHandler: signupRateLimit }, async (req, reply) => {
    const b = req.body as {
      email?: string;
      password?: string;
      displayName?: string;
      workspaceSlug?: string;
    };
    if (!b.email || !b.password || !b.displayName || !b.workspaceSlug) {
      return reply.code(400).send({ error: "email, password, displayName, workspaceSlug required" });
    }
    if (await findUserByEmail(b.email)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const ws =
      (await getWorkspaceBySlug(b.workspaceSlug)) ??
      (await createWorkspace({ slug: b.workspaceSlug, name: b.workspaceSlug }));
    const { userId, memberId } = await createHumanAccount({
      workspaceId: ws.id,
      email: b.email,
      passwordHash: await hashPassword(b.password),
      displayName: b.displayName,
    });
    const { raw, hash } = generateSessionToken();
    await createSession({ userId, tokenHash: hash, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    setSessionCookie(reply, raw);
    // #123: when the deployment opts in (marketing.enabled), seed the department fleet so the owner
    // lands inside a working agency. Best-effort — the hook never throws, so signup can't be broken.
    if (opts.onWorkspaceCreated) await opts.onWorkspaceCreated(ws.id, memberId);
    return reply.code(201).send({ ok: true });
  });

  app.post("/auth/login", { preHandler: loginRateLimit }, async (req, reply) => {
    const b = req.body as { email?: string; password?: string };
    const user = await findUserByEmail(b.email ?? "");
    if (!user || !user.passwordHash || !(await verifyPassword(b.password ?? "", user.passwordHash))) {
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
