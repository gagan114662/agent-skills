export type BackgroundLoopName =
  | "approval_expiry"
  | "autonomy"
  | "watchdog"
  | "sre"
  | "self_healing"
  | "flywheel"
  | "build_loop";

export interface BackgroundLoopState {
  name: BackgroundLoopName;
  intervalMs: number;
  enabled: boolean;
  critical: boolean;
  registeredAt: string;
}

const loops = new Map<BackgroundLoopName, BackgroundLoopState>();

export function registerBackgroundLoop(input: {
  name: BackgroundLoopName;
  intervalMs: number;
  critical?: boolean;
  now?: Date;
}): BackgroundLoopState {
  const intervalMs = Math.max(0, Math.trunc(input.intervalMs));
  const state: BackgroundLoopState = {
    name: input.name,
    intervalMs,
    enabled: intervalMs > 0,
    critical: input.critical ?? false,
    registeredAt: (input.now ?? new Date()).toISOString(),
  };
  loops.set(input.name, state);
  return state;
}

export function listBackgroundLoops(): BackgroundLoopState[] {
  return [...loops.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resetBackgroundLoopsForTest(): void {
  loops.clear();
}

export function productionLoopReadiness(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.RELOAD_ENV === "production";
}

export function getBackgroundLoopReadiness(input: {
  production?: boolean;
} = {}): { ready: boolean; disabledCritical: BackgroundLoopState[]; loops: BackgroundLoopState[] } {
  const states = listBackgroundLoops();
  const production = input.production ?? productionLoopReadiness();
  const disabledCritical = production ? states.filter((loop) => loop.critical && !loop.enabled) : [];
  return {
    ready: disabledCritical.length === 0,
    disabledCritical,
    loops: states,
  };
}
