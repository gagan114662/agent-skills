export type VisibilityChannelCommand =
  | {
      kind: "approval_decision";
      decision: "approve" | "reject";
      target: string;
      reason: string | null;
    }
  | {
      kind: "pause";
      target: string;
      reason: string | null;
    }
  | {
      kind: "show";
      target: string;
    };

function cleanTarget(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

function splitTargetAndReason(value: string): { target: string; reason: string | null } {
  const match = value.match(/^(.*?)(?:\s+(?:because|reason:)\s+(.+))$/i);
  if (!match) return { target: cleanTarget(value), reason: null };
  return { target: cleanTarget(match[1] ?? ""), reason: cleanTarget(match[2] ?? "") || null };
}

/**
 * Parse explicit messaging-room commands (#1267). This is intentionally conservative: the parser only
 * recognizes phrases a human would reasonably mean as a decision or room command, and it returns intent
 * for the caller to audit/route. It never executes the decision by itself.
 */
export function parseVisibilityChannelCommand(text: string): VisibilityChannelCommand | null {
  const raw = text.trim();
  if (!raw) return null;

  const yes = raw.match(/^(?:yes|approve|approved|ship|send|publish)\s+(.+)$/i);
  if (yes) {
    const { target, reason } = splitTargetAndReason(yes[1] ?? "");
    if (!target) return null;
    return { kind: "approval_decision", decision: "approve", target, reason };
  }

  const no = raw.match(/^(?:no|reject|rejected|deny|denied|do not ship|don't ship|dont ship)\s+(.+)$/i);
  if (no) {
    const { target, reason } = splitTargetAndReason(no[1] ?? "");
    if (!target) return null;
    return { kind: "approval_decision", decision: "reject", target, reason };
  }

  const pause = raw.match(/^(?:pause|hold|stop)\s+(.+)$/i);
  if (pause) {
    const { target, reason } = splitTargetAndReason(pause[1] ?? "");
    if (!target) return null;
    return { kind: "pause", target, reason };
  }

  const show = raw.match(/^(?:show me|show|send me|share)\s+(.+)$/i);
  if (show) {
    const target = cleanTarget(show[1] ?? "");
    if (!target) return null;
    return { kind: "show", target };
  }

  return null;
}
