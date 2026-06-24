import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthSessionCleanupEngine,
  type AuthSessionCleanupStore,
} from "../../src/auth/session-cleanup.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
  logger.info.mockClear();
  logger.error.mockClear();
});

function makeStore(now: Date): { store: AuthSessionCleanupStore; rows: Array<{ token: string; expiresAt: Date }> } {
  const rows = [
    { token: "expired-old", expiresAt: new Date(now.getTime() - 60_000) },
    { token: "expired-now", expiresAt: new Date(now.getTime()) },
    { token: "valid", expiresAt: new Date(now.getTime() + 60_000) },
  ];
  const store: AuthSessionCleanupStore = {
    async deleteExpiredSessions(input) {
      const doomed = rows
        .filter((row) => row.expiresAt.getTime() <= input.now.getTime())
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, input.limit);
      for (const row of doomed) {
        const index = rows.findIndex((candidate) => candidate.token === row.token);
        if (index >= 0) rows.splice(index, 1);
      }
      return doomed.length;
    },
  };
  return { store, rows };
}

describe("AuthSessionCleanupEngine (#960)", () => {
  it("deletes expired session rows and retains valid rows", async () => {
    const now = new Date("2026-06-24T04:20:00.000Z");
    const { store, rows } = makeStore(now);
    const engine = new AuthSessionCleanupEngine({
      config: { intervalMs: 3_600_000, batchSize: 100 },
      store,
      logger,
      now: () => now,
    });

    await expect(engine.tick()).resolves.toEqual({ deleted: 2 });
    expect(rows.map((row) => row.token)).toEqual(["valid"]);
    expect(logger.info).toHaveBeenCalledWith(
      { deleted: 2 },
      "auth session cleanup removed expired sessions",
    );
  });

  it("honors the batch limit", async () => {
    const now = new Date("2026-06-24T04:20:00.000Z");
    const { store, rows } = makeStore(now);
    const engine = new AuthSessionCleanupEngine({
      config: { intervalMs: 3_600_000, batchSize: 1 },
      store,
      logger,
      now: () => now,
    });

    await expect(engine.tick()).resolves.toEqual({ deleted: 1 });
    expect(rows.map((row) => row.token)).toEqual(["expired-now", "valid"]);
  });

  it("runs immediately on start and again on the configured interval", async () => {
    vi.useFakeTimers();
    const store: AuthSessionCleanupStore = {
      deleteExpiredSessions: vi.fn(async () => 0),
    };
    const engine = new AuthSessionCleanupEngine({
      config: { intervalMs: 1_000, batchSize: 10 },
      store,
      logger,
    });

    engine.start();
    expect(store.deleteExpiredSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.deleteExpiredSessions).toHaveBeenCalledTimes(2);
    engine.stop();
  });

  it("does not start when the interval is disabled", async () => {
    vi.useFakeTimers();
    const store: AuthSessionCleanupStore = {
      deleteExpiredSessions: vi.fn(async () => 0),
    };
    const engine = new AuthSessionCleanupEngine({
      config: { intervalMs: 0, batchSize: 10 },
      store,
      logger,
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.deleteExpiredSessions).not.toHaveBeenCalled();
  });
});
