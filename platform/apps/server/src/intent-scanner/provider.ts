import type { IntentCandidate, IntentMonitorDefinition, IntentScannerProvider } from "./types.js";

/**
 * Default provider for #1548. The transport pipes for Reddit/X live in #395; until those credentials and
 * fetchers are connected, the scheduler still runs safely and the manual/provider seam is fully tested.
 */
export class EmptyIntentScannerProvider implements IntentScannerProvider {
  scan(_monitor: IntentMonitorDefinition, _opts: { since: Date | null; now: Date }): Promise<IntentCandidate[]> {
    return Promise.resolve([]);
  }
}
