import type { IMessageEnv } from "../env.js";
import { MacOsMessagesAdapter } from "./macos-adapter.js";
import { IMessageRelayService } from "./service.js";

export function createIMessageRelayService(env: IMessageEnv): IMessageRelayService {
  return new IMessageRelayService(env, new MacOsMessagesAdapter(env.osascriptBin));
}
