import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUserByEmail = vi.fn();
const createHumanAccount = vi.fn();
const createSession = vi.fn();
const deleteSession = vi.fn();
const getWorkspaceBySlug = vi.fn();
const createWorkspace = vi.fn();

vi.mock("../../src/auth/secrets.js", () => ({
  hashPassword: vi.fn(async () => "hashed-password"),
  verifyPassword: vi.fn(async () => true),
  generateSessionToken: vi.fn(() => ({ raw: "session-raw", hash: "session-hash" })),
  hashToken: vi.fn(() => "session-hash"),
}));

vi.mock("../../src/db/repositories/auth.js", () => ({
  findUserByEmail,
  createHumanAccount,
  createSession,
  deleteSession,
}));

vi.mock("../../src/db/repositories/workspaces.js", () => ({
  getWorkspaceBySlug,
  createWorkspace,
}));

const { authRoutes } = await import("../../src/routes/auth.js");

async function buildRoute() {
  const app = Fastify();
  await app.register(cookie);
  await app.register(authRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  findUserByEmail.mockResolvedValue(undefined);
  getWorkspaceBySlug.mockResolvedValue({ id: "w1", slug: "acme", name: "acme", timezone: "UTC" });
  createWorkspace.mockResolvedValue({ id: "w1", slug: "acme", name: "acme", timezone: "UTC" });
  createHumanAccount.mockResolvedValue({ userId: "u1", memberId: "m1" });
  createSession.mockResolvedValue(undefined);
  deleteSession.mockResolvedValue(undefined);
});

describe("authRoutes", () => {
  it("rejects a signup password below the server minimum with a specific message", async () => {
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: { email: "weak@example.com", password: "x", displayName: "Weak", workspaceSlug: "acme" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "password must be at least 2 characters" });
      expect(findUserByEmail).not.toHaveBeenCalled();
      expect(createHumanAccount).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
