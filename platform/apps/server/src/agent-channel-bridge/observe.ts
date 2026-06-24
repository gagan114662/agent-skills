import type { BridgeResult, CoordinationEvent } from "./events.js";

export interface CoordinationBridgeLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export function observeBridgeResult(
  log: CoordinationBridgeLogger | undefined,
  workspaceId: string,
  event: CoordinationEvent,
  result: BridgeResult,
  context: Record<string, unknown> = {},
): void {
  if (result.posted) return;

  log?.warn(
    {
      ...context,
      workspaceId,
      kind: event.kind,
      channel: event.channel,
      reason: result.reason,
    },
    "coordination bridge post not delivered",
  );
}
