import { randomBytes } from "node:crypto";
import { getRedis } from "../redis/index.js";

export const TELEGRAM_CONNECT_CODE_TTL_SECONDS = 10 * 60;

const CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_PREFIX = "telegram-room-connect:";

export interface TelegramConnectCodeRecord {
  workspaceId: string;
  memberId: string;
  createdAtMs: number;
}

export interface TelegramConnectCode {
  code: string;
  expiresAtMs: number;
}

function keyFor(code: string): string {
  return KEY_PREFIX + code;
}

export function normalizeTelegramConnectCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return CODE_PATTERN.test(value) ? value : null;
}

export async function createTelegramConnectCode(
  input: Omit<TelegramConnectCodeRecord, "createdAtMs">,
): Promise<TelegramConnectCode> {
  const code = randomBytes(18).toString("base64url");
  const createdAtMs = Date.now();
  const record: TelegramConnectCodeRecord = {
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    createdAtMs,
  };
  await getRedis().set(keyFor(code), JSON.stringify(record), "EX", TELEGRAM_CONNECT_CODE_TTL_SECONDS);
  return { code, expiresAtMs: createdAtMs + TELEGRAM_CONNECT_CODE_TTL_SECONDS * 1000 };
}

export async function consumeTelegramConnectCode(raw: unknown): Promise<TelegramConnectCodeRecord | null> {
  const code = normalizeTelegramConnectCode(raw);
  if (!code) return null;
  const value = await getRedis().eval(
    "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v",
    1,
    keyFor(code),
  );
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as TelegramConnectCodeRecord;
    if (
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.memberId !== "string" ||
      typeof parsed.createdAtMs !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseTelegramStartCode(text: string): string | null {
  const match = /^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s+([A-Za-z0-9_-]{16,64}))?\s*$/i.exec(text.trim());
  return normalizeTelegramConnectCode(match?.[1] ?? null);
}
