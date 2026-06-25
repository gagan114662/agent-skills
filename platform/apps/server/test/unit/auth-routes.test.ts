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

async function buildRouteWithHook(onWorkspaceCreated: Parameters<typeof authRoutes>[1]["onWorkspaceCreated"]) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(authRoutes, { onWorkspaceCreated });
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

  it("passes signup attribution from query params into the workspace-created hook (#901)", async () => {
    const onWorkspaceCreated = vi.fn(async () => undefined);
    const app = await buildRouteWithHook(onWorkspaceCreated);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/signup?utm_source=producthunt&utm_medium=launch&utm_campaign=alpha&ref=trk_123",
        payload: {
          email: "ada@example.com",
          password: "pw",
          displayName: "Ada",
          workspaceSlug: "acme",
        },
      });

      expect(res.statusCode).toBe(201);
      expect(onWorkspaceCreated).toHaveBeenCalledWith("w1", "m1", {
        source: "producthunt",
        utmSource: "producthunt",
        utmMedium: "launch",
        utmCampaign: "alpha",
        trackingRef: "trk_123",
        referralCode: null,
      });
    } finally {
      await app.close();
    }
  });

  it("passes a sanitized referral code from signup into the workspace-created hook (#603)", async () => {
    const onWorkspaceCreated = vi.fn(async () => undefined);
    const app = await buildRouteWithHook(onWorkspaceCreated);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/signup?referral=ref_abc123",
        payload: {
          email: "grace@example.com",
          password: "pw",
          displayName: "Grace",
          workspaceSlug: "acme",
        },
      });

      expect(res.statusCode).toBe(201);
      expect(onWorkspaceCreated).toHaveBeenCalledWith(
        "w1",
        "m1",
        expect.objectContaining({ referralCode: "ref_abc123" }),
      );
    } finally {
      await app.close();
    }
  });
});
