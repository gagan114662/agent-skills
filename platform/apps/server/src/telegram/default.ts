import type { TelegramEnv } from "../env.js";
import { TelegramRoomService } from "./service.js";

export function createTelegramRoomService(env: TelegramEnv): TelegramRoomService {
  return new TelegramRoomService(env);
}

