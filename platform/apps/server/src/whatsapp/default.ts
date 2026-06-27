import type { WhatsAppEnv } from "../env.js";
import { WhatsAppRoomService } from "./service.js";

export function createWhatsAppRoomService(env: WhatsAppEnv): WhatsAppRoomService {
  return new WhatsAppRoomService(env);
}

