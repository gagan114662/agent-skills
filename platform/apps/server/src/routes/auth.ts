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

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function setSessionCookie(reply: FastifyReply, raw: string): void {
  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/signup", async (req, reply) => {
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
      return reply.code(409).send({ error: "email already in use" });
    }
    const ws =
      (await getWorkspaceBySlug(b.workspaceSlug)) ??
      (await createWorkspace({ slug: b.workspaceSlug, name: b.workspaceSlug }));
    const { userId } = await createHumanAccount({
      workspaceId: ws.id,
      email: b.email,
      passwordHash: await hashPassword(b.password),
      displayName: b.displayName,
    });
    const { raw, hash } = generateSessionToken();
    await createSession({ userId, tokenHash: hash, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    setSessionCookie(reply, raw);
    return reply.code(201).send({ ok: true });
  });

  app.post("/auth/login", async (req, reply) => {
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
