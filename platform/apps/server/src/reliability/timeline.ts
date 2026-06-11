/**
 * Pure helpers for the chat-native incident war-room (#148, ADR-0148): the `#incident-NNN` channel
 * name and the timeline message bodies the coordinator posts as the incident unfolds (detected →
 * triage launched → still-firing → resolved). No IO — the coordinator owns the posting.
 */

/** The minimal incident shape the timeline messages reference. */
export interface TimelineIncident {
  id: string;
  service: string;
  sloKind: string;
  severity: "warning" | "critical";
  observedValue: number;
  targetValue: number;
}

/** The war-room channel name for a per-workspace incident sequence (`#incident-007`). */
export function incidentChannelName(seq: number): string {
  return `incident-${String(seq).padStart(3, "0")}`;
}

const EMOJI = { warning: "🟠", critical: "🔴" } as const;

export function detectedMessage(incident: TimelineIncident): string {
  return (
    `${EMOJI[incident.severity]} **Incident detected** — ${incident.service} ${incident.sloKind} ` +
    `breached (observed ${incident.observedValue}, target ${incident.targetValue}, severity ${incident.severity}). ` +
    `Triage is being launched; the AI investigation note follows.`
  );
}

export function triageMessage(triageSessionId: string): string {
  return `🧭 **Triage agent launched** (session ${triageSessionId}). Diagnosis only — remediation stays gated.`;
}

export function repagedMessage(incident: TimelineIncident): string {
  return (
    `${EMOJI[incident.severity]} **Still firing** — ${incident.service} ${incident.sloKind} has not recovered. ` +
    `Owner re-paged (escalation).`
  );
}

export function resolvedMessage(incident: TimelineIncident, postmortemPath: string): string {
  return (
    `✅ **Incident resolved** — ${incident.service} ${incident.sloKind} recovered. ` +
    `Postmortem drafted at \`${postmortemPath}\`.`
  );
}
