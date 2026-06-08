import { channelPoster } from "../runtime/default.js";
import type { SessionLogger } from "../runtime/manager.js";
import { AutonomyEngine } from "./engine.js";

/**
 * Build the production AutonomyEngine (#17). It reuses the #25 channel poster (persist + realtime
 * publish), so an autonomous agent's narration is both live and persisted. The periodic timer is
 * started separately (and only when `AUTONOMY_INTERVAL_MS > 0`) so tests can drive `tick()`.
 */
export function createDefaultAutonomyEngine(logger: SessionLogger): AutonomyEngine {
  return new AutonomyEngine({ poster: channelPoster, logger });
}
