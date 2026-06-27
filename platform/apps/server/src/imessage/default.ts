import type { IMessageEnv } from "../env.js";
import { MacOsMessagesAdapter } from "./macos-adapter.js";
import { IMessageRelayService } from "./service.js";

export function createIMessageRelayService(env: IMessageEnv): IMessageRelayService {
  const canUseLocalMessages = process.platform === "darwin" && env.macosHost;
  return new IMessageRelayService(
    {
      ...env,
      enabled: env.enabled && (env.dryRun || canUseLocalMessages),
    },
    new MacOsMessagesAdapter(env.osascriptBin),
  );
}
