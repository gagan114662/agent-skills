/**
 * Data-privacy policy (#58). The single gate every off-platform egress point consults: when a
 * deployment (or tenant, via managed config) turns data-privacy mode ON, no agent task, result, or
 * notification may leave the process. Today's egress points are the Braintrust trace exporter and
 * the notification webhook transport; both call this before sending anything off-platform.
 */
export interface EgressPolicy {
  dataPrivacyMode: boolean;
}

/** True when off-platform data egress is permitted (i.e. data-privacy mode is OFF). */
export function egressAllowed(policy: EgressPolicy): boolean {
  return !policy.dataPrivacyMode;
}
