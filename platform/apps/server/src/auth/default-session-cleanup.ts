import { loadEnv } from "../env.js";
import { deleteExpiredSessions } from "../db/repositories/auth.js";
import type { FastifyBaseLogger } from "fastify";
import { AuthSessionCleanupEngine } from "./session-cleanup.js";

export function createDefaultAuthSessionCleanupEngine(logger: FastifyBaseLogger): AuthSessionCleanupEngine {
  return new AuthSessionCleanupEngine({
    config: loadEnv().authSessionCleanup,
    store: { deleteExpiredSessions },
    logger,
  });
}
