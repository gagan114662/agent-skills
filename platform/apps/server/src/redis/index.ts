import { Redis } from "ioredis";
import { loadEnv } from "../env.js";

let client: Redis | undefined;

export const REDIS_COMMAND_TIMEOUT_MS = 1_000;

/** Lazily-created shared Redis client. */
export function getRedis(): Redis {
  if (!client) {
    // lazyConnect + bounded retries so a missing Redis degrades health rather than crashing boot.
    client = new Redis(loadEnv().redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    });
    client.on("error", () => {
      /* surfaced via pingRedis(); swallow to avoid unhandled error events */
    });
  }
  return client;
}

/** Returns true if Redis answers PING. Never throws. */
export async function pingRedis(): Promise<boolean> {
  try {
    const redis = getRedis();
    if (redis.status !== "ready") {
      await redis.connect().catch(() => undefined);
    }
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = undefined;
  }
}
