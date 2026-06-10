/**
 * Maintenance flag storage (#99, ADR-0099). The flag is one global key in the Redis already in the
 * stack — read per request by the gate, flipped in seconds by the CLI/route with no redeploy. Both
 * read and write **fail open**: any Redis error resolves to a disabled/`unavailable` state and never
 * throws, so a Redis outage can never lock the platform read-only. See ADR-0099 §1.
 */
import { getRedis } from "../redis/index.js";
import type { MaintenanceState } from "./policy.js";

/** The single global key holding the maintenance flag. */
export const MAINTENANCE_KEY = "reload:maintenance";

/** The slice of the Redis client this module needs (ioredis satisfies it; tests inject a double). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** What we persist in the key (value is JSON). `enabled` is implied by the key's presence. */
interface StoredFlag {
  since: string;
  reason?: string;
  by?: string;
}

/** Read the current maintenance state. Never throws — a Redis error reports `unavailable` (fail open). */
export async function getMaintenanceState(redis?: RedisLike): Promise<MaintenanceState> {
  try {
    const client = redis ?? getRedis();
    const raw = await client.get(MAINTENANCE_KEY);
    if (!raw) return { enabled: false };
    try {
      const parsed = JSON.parse(raw) as StoredFlag;
      return { enabled: true, since: parsed.since, reason: parsed.reason, by: parsed.by };
    } catch {
      // A malformed value still means "the flag is set"; surface it as enabled with no metadata.
      return { enabled: true };
    }
  } catch {
    return { enabled: false, unavailable: true };
  }
}

/**
 * Flip maintenance on or off. Returns the resulting state. Never throws — a Redis error resolves to
 * an `unavailable` state so the caller can report the failure without crashing (fail open).
 */
export async function setMaintenance(
  on: boolean,
  meta: { reason?: string; by?: string; now?: Date } = {},
  redis?: RedisLike,
): Promise<MaintenanceState> {
  try {
    const client = redis ?? getRedis();
    if (!on) {
      await client.del(MAINTENANCE_KEY);
      return { enabled: false };
    }
    const since = (meta.now ?? new Date()).toISOString();
    const stored: StoredFlag = { since, reason: meta.reason, by: meta.by };
    await client.set(MAINTENANCE_KEY, JSON.stringify(stored));
    return { enabled: true, since, reason: meta.reason, by: meta.by };
  } catch {
    return { enabled: on, unavailable: true };
  }
}

/** Convenience for the loop guards: is maintenance currently active? Fail-open ⇒ false on any error. */
export async function isMaintenanceActive(redis?: RedisLike): Promise<boolean> {
  return (await getMaintenanceState(redis)).enabled;
}
